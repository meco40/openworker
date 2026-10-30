//! Port of `app/api/tasks/[id]/planning/route.ts`, `planning/answer`, `planning/poll` and
//! `planning/retry-dispatch`, with the helpers of `src/lib/planning-utils.ts`
//! (`extractJSON`, `getMessagesFromBetaClaw`).
//!
//! The planning conversation lives in a runtime session. The task keeps the message
//! list, the spec and the agents as JSON text in its own columns.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path as AxumPath, State};
use axum::http::HeaderMap;
use axum::response::Response;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use super::access::{resolve, task_workspace, Access};
use super::dispatch::dispatch_task;
use super::wire::{
    body_strict, error, internal, js_string, notify, query_first, query_rows, reply, text_key,
    truthy, utf16_len, Fault, Outcome,
};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::{AppState, SharedState};

const PLANNING_PREFIX: &str = "agent:main:planning";
/// `MAX_EXTRACT_JSON_LENGTH` of `planning-utils.ts`.
const MAX_EXTRACT_JSON_LENGTH: usize = 1_000_000;

fn planning_row(connection: &Connection, task_id: &str) -> rusqlite::Result<Option<Value>> {
    query_first(connection, "SELECT * FROM tasks WHERE id = ?", [task_id])
}

/// `JSON.parse` of a stored text column. A NULL or empty column is `None`.
fn stored_json(row: &Value, key: &str) -> Result<Option<Value>, Fault> {
    match text_key(row, key) {
        Some(text) => Ok(Some(serde_json::from_str(text)?)),
        None => Ok(None),
    }
}

/// `planning_messages`, parsed. A missing column is an empty list.
fn stored_messages(row: &Value) -> Result<Vec<Value>, Fault> {
    Ok(match stored_json(row, "planning_messages")? {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    })
}

/// `extractJSON`: the whole text, the first fenced block, or the span from the first
/// `{` to the last `}`. `None` when none of them parses.
pub fn extract_json(text: &str) -> Option<Value> {
    if utf16_len(text) > MAX_EXTRACT_JSON_LENGTH {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Some(value);
    }
    if let Some(block) = fenced_block(text) {
        if let Ok(value) = serde_json::from_str::<Value>(block.trim()) {
            return Some(value);
        }
    }
    let first = text.find('{')?;
    let last = text.rfind('}')?;
    if last > first {
        serde_json::from_str::<Value>(&text[first..=last]).ok()
    } else {
        None
    }
}

/// The text between the first pair of ``` fences, after an optional `json` tag.
fn fenced_block(text: &str) -> Option<&str> {
    let start = text.find("```")? + 3;
    let rest = text[start..]
        .strip_prefix("json")
        .unwrap_or(&text[start..])
        .trim_start();
    let end = rest.find("```")?;
    Some(&rest[..end])
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `buildPlanningSessionKey`: a new key per planning run, so no history carries over.
fn planning_session_key(task_id: &str) -> String {
    let nonce = to_base36(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let short_id = Uuid::new_v4()
        .to_string()
        .split('-')
        .next()
        .unwrap_or_default()
        .to_string();
    format!("{PLANNING_PREFIX}:{task_id}:{nonce}-{short_id}")
}

fn planning_prompt(title: &str, description: &str) -> String {
    format!(
        "PLANNING REQUEST\n\nTask Title: {title}\nTask Description: {description}\n\nYou are starting a planning session for this task. Read PLANNING.md for your protocol.\n\nGenerate your FIRST question to understand what the user needs. Remember:\n- Questions must be multiple choice\n- Include an \"Other\" option\n- Be specific to THIS task, not generic\n\nRespond with ONLY valid JSON in this format:\n{{\n  \"question\": \"Your question here?\",\n  \"options\": [\n    {{\"id\": \"A\", \"label\": \"First option\"}},\n    {{\"id\": \"B\", \"label\": \"Second option\"}},\n    {{\"id\": \"C\", \"label\": \"Third option\"}},\n    {{\"id\": \"other\", \"label\": \"Other\"}}\n  ]\n}}"
    )
}

fn answer_prompt(answer_text: &str) -> String {
    format!(
        "User's answer: {answer_text}\n\nBased on this answer and the conversation so far, either:\n1. Ask your next question (if you need more information)\n2. Complete the planning (if you have enough information)\n\nFor another question, respond with JSON:\n{{\n  \"question\": \"Your next question?\",\n  \"options\": [\n    {{\"id\": \"A\", \"label\": \"Option A\"}},\n    {{\"id\": \"B\", \"label\": \"Option B\"}},\n    {{\"id\": \"other\", \"label\": \"Other\"}}\n  ]\n}});\n\nIf planning is complete, respond with JSON:\n{{\n  \"status\": \"complete\",\n  \"spec\": {{\n    \"title\": \"Task title\",\n    \"summary\": \"Summary of what needs to be done\",\n    \"deliverables\": [\"List of deliverables\"],\n    \"success_criteria\": [\"How we know it's done\"],\n    \"constraints\": {{}}\n  }},\n  \"agents\": [\n    {{\n      \"name\": \"Agent Name\",\n      \"role\": \"Agent role\",\n      \"avatar_emoji\": \"🎯\",\n      \"soul_md\": \"Agent personality...\",\n      \"instructions\": \"Specific instructions...\"\n    }}\n  ],\n  \"execution_plan\": {{\n    \"approach\": \"How to execute\",\n    \"steps\": [\"Step 1\", \"Step 2\"]\n  }}\n}}"
    )
}

/// `getMessagesFromBetaClaw`: the text of the assistant messages of the session.
/// Any failure reads as no messages, as in the source.
async fn runtime_assistant_messages(services: &Services, session_key: &str) -> Vec<String> {
    if services.ensure_connected().await.is_err() {
        return Vec::new();
    }
    let history = match services
        .runtime
        .call(
            "chat.history",
            json!({ "sessionKey": session_key, "limit": 50 }),
        )
        .await
    {
        Ok(history) => history,
        Err(failure) => {
            tracing::error!(%failure, "[Planning Utils] Failed to get messages from BetaClaw");
            return Vec::new();
        }
    };
    let Some(messages) = history.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    messages
        .iter()
        .filter(|message| message["role"] == "assistant")
        .filter_map(|message| {
            let parts = message.get("content")?.as_array()?;
            let text = parts
                .iter()
                .find(|part| part["type"] == "text")?
                .get("text")?
                .as_str()?;
            (!text.trim().is_empty()).then(|| text.to_string())
        })
        .collect()
}

// ------------------------------------------------------- GET /planning

/// `GET /api/tasks/{id}/planning`
pub async fn get_state(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    get_state_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to get planning state", fault))
}

fn get_state_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let Some(row) = planning_row(&connection, task_id)? else {
        return Ok(error(404, "Task not found"));
    };
    let messages = stored_messages(&row)?;
    let current_question = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "assistant")
        .and_then(|message| message.get("content")?.as_str())
        .and_then(extract_json)
        .filter(|parsed| parsed.get("question").is_some());

    let dispatch_error = text_key(&row, "planning_dispatch_error").map(str::to_string);
    let complete = truthy(row.get("planning_complete")) || dispatch_error.is_some();
    let is_started = !messages.is_empty();
    let mut body = json!({
        "taskId": task_id,
        "sessionKey": row.get("planning_session_key").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "currentQuestion": if complete { Value::Null } else { current_question.unwrap_or(Value::Null) },
        "isComplete": complete,
        "spec": stored_json(&row, "planning_spec")?.unwrap_or(Value::Null),
        "agents": stored_json(&row, "planning_agents")?.unwrap_or(Value::Null),
        "isStarted": is_started,
    });
    if let Some(dispatch_error) = dispatch_error {
        body["dispatchError"] = json!(dispatch_error);
    }
    Ok(reply(200, body))
}

// ------------------------------------------------------ POST /planning

/// `POST /api/tasks/{id}/planning`: starts the planning session.
pub async fn start(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match start_inner(&services, &access, &id).await {
        Ok(response) => response,
        Err(fault) => error(500, &format!("Failed to start planning: {}", fault.0)),
    }
}

async fn start_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let (row, others) = {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, task_id)? {
            return Ok(error(404, "Task not found"));
        }
        let Some(row) = planning_row(&connection, task_id)? else {
            return Ok(error(404, "Task not found"));
        };
        if let Some(session_key) = text_key(&row, "planning_session_key") {
            return Ok(reply(
                400,
                json!({ "error": "Planning already started", "sessionKey": session_key }),
            ));
        }
        let workspace = text_key(&row, "workspace_id").unwrap_or("");
        let master = query_first(
            &connection,
            "SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1",
            [workspace],
        )?;
        let master_id = master
            .as_ref()
            .and_then(|master| text_key(master, "id"))
            .unwrap_or("");
        let others = query_rows(
            &connection,
            "SELECT id, name, role FROM agents
             WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'",
            params![master_id, workspace],
        )?;
        (row, others)
    };

    if !others.is_empty() {
        let count = others.len();
        let names = others
            .iter()
            .map(|other| other.get("name").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join(", ");
        let verb = if count == 1 { "is" } else { "are" };
        let plural = if count == 1 { "" } else { "s" };
        let message = format!(
            "There {verb} {count} other orchestrator{plural} available in this workspace: {names}. Please assign this task to them directly."
        );
        return Ok(reply(
            409,
            json!({
                "error": "Other orchestrators available",
                "message": message,
                "otherOrchestrators": others,
            }),
        ));
    }

    let session_key = planning_session_key(task_id);
    let title = row.get("title").and_then(Value::as_str).unwrap_or("");
    let description = text_key(&row, "description").unwrap_or("No description provided");
    let prompt = planning_prompt(title, description);
    services.ensure_connected().await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    services
        .runtime
        .call(
            "chat.send",
            json!({
                "sessionKey": session_key,
                "message": prompt,
                "idempotencyKey": format!("planning-start-{task_id}-{now_ms}"),
            }),
        )
        .await?;

    let messages = json!([{ "role": "user", "content": prompt, "timestamp": now_ms }]);
    {
        let connection = services.tasks.connection();
        connection.execute(
            "UPDATE tasks SET planning_session_key = ?, planning_messages = ?, status = 'planning'
             WHERE id = ?",
            params![session_key, messages.to_string(), task_id],
        )?;
    }
    Ok(reply(
        200,
        json!({
            "success": true,
            "sessionKey": session_key,
            "messages": messages,
            "note": "Planning started. Poll GET endpoint for updates.",
        }),
    ))
}

// ----------------------------------------------------- DELETE /planning

/// `DELETE /api/tasks/{id}/planning`: cancels the planning and puts the task back in the inbox.
pub async fn cancel(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    cancel_inner(&state, &services, &access, &id)
        .unwrap_or_else(|fault| error(500, &format!("Failed to cancel planning: {}", fault.0)))
}

fn cancel_inner(state: &AppState, services: &Services, access: &Access, task_id: &str) -> Outcome {
    let updated = {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, task_id)? {
            return Ok(error(404, "Task not found"));
        }
        if planning_row(&connection, task_id)?.is_none() {
            return Ok(error(404, "Task not found"));
        }
        connection.execute(
            "UPDATE tasks
             SET planning_session_key = NULL, planning_messages = NULL, planning_complete = 0,
                 planning_spec = NULL, planning_agents = NULL, status = 'inbox',
                 updated_at = datetime('now')
             WHERE id = ?",
            [task_id],
        )?;
        planning_row(&connection, task_id)?
    };
    if let Some(task) = updated {
        notify(state, "task_updated", task);
    }
    Ok(reply(200, json!({ "success": true })))
}

// ------------------------------------------------------- POST /planning/answer

/// `POST /api/tasks/{id}/planning/answer`
pub async fn answer(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match answer_inner(&services, &access, &id, &body).await {
        Ok(response) => response,
        Err(fault) => error(500, &format!("Failed to submit answer: {}", fault.0)),
    }
}

async fn answer_inner(
    services: &Services,
    access: &Access,
    task_id: &str,
    body: &Bytes,
) -> Outcome {
    {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, task_id)? {
            return Ok(error(404, "Task not found"));
        }
    }
    let body = body_strict(body)?;
    let answer = body.get("answer").cloned().unwrap_or(Value::Null);
    if !truthy(Some(&answer)) {
        return Ok(error(400, "Answer is required"));
    }

    let row = {
        let connection = services.tasks.connection();
        planning_row(&connection, task_id)?
    };
    let Some(row) = row else {
        return Ok(error(404, "Task not found"));
    };
    let Some(session_key) = text_key(&row, "planning_session_key").map(str::to_string) else {
        return Ok(error(400, "Planning not started"));
    };

    let Some(answer_raw) = answer.as_str() else {
        return Err(Fault("answer?.toLowerCase is not a function".to_string()));
    };
    let other_text = body.get("otherText").filter(|value| truthy(Some(*value)));
    let answer_text = match other_text {
        Some(other) if answer_raw.to_lowercase() == "other" => {
            format!("Other: {}", js_string(other))
        }
        _ => answer_raw.to_string(),
    };

    let mut messages = stored_messages(&row)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    messages.push(json!({ "role": "user", "content": answer_text, "timestamp": now_ms }));

    services.ensure_connected().await?;
    if let Err(failure) = services
        .runtime
        .call(
            "chat.send",
            json!({
                "sessionKey": session_key,
                "message": answer_prompt(&answer_text),
                "idempotencyKey": format!("planning-answer-{task_id}-{now_ms}"),
            }),
        )
        .await
    {
        return Ok(error(
            500,
            &format!("Failed to send answer to orchestrator: {failure}"),
        ));
    }

    let messages = Value::Array(messages);
    {
        let connection = services.tasks.connection();
        connection.execute(
            "UPDATE tasks SET planning_messages = ? WHERE id = ?",
            params![messages.to_string(), task_id],
        )?;
    }
    Ok(reply(
        200,
        json!({
            "success": true,
            "messages": messages,
            "note": "Answer submitted. Poll GET endpoint for updates.",
        }),
    ))
}

// ------------------------------------------------------- GET /planning/poll

/// `GET /api/tasks/{id}/planning/poll`
pub async fn poll(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match poll_inner(&state, &services, &access, &id).await {
        Ok(response) => response,
        Err(fault) => internal("Failed to poll for updates", fault),
    }
}

async fn poll_inner(
    state: &AppState,
    services: &Services,
    access: &Access,
    task_id: &str,
) -> Outcome {
    let row = {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, task_id)? {
            return Ok(error(404, "Task not found"));
        }
        planning_row(&connection, task_id)?
    };
    let Some(row) = row else {
        return Ok(error(404, "Planning session not found"));
    };
    let Some(session_key) = text_key(&row, "planning_session_key").map(str::to_string) else {
        return Ok(error(404, "Planning session not found"));
    };
    if truthy(row.get("planning_complete")) {
        return Ok(reply(
            200,
            json!({ "hasUpdates": false, "complete": true, "isComplete": true }),
        ));
    }
    if let Some(dispatch_error) = text_key(&row, "planning_dispatch_error") {
        return Ok(reply(
            200,
            json!({
                "hasUpdates": true,
                "complete": true,
                "isComplete": true,
                "dispatchError": dispatch_error,
            }),
        ));
    }

    let mut messages = stored_messages(&row)?;
    let initial = messages
        .iter()
        .filter(|message| message["role"] == "assistant")
        .count();
    let fetched = runtime_assistant_messages(services, &session_key).await;
    if fetched.len() <= initial {
        return Ok(reply(200, json!({ "hasUpdates": false })));
    }

    let mut current_question: Option<Value> = None;
    for content in &fetched[initial..] {
        let now_ms = chrono::Utc::now().timestamp_millis();
        messages.push(json!({ "role": "assistant", "content": content, "timestamp": now_ms }));
        match extract_json(content) {
            Some(parsed) if parsed.get("status").and_then(Value::as_str) == Some("complete") => {
                return finish_planning(state, services, task_id, parsed, messages).await;
            }
            Some(parsed) if truthy(parsed.get("question")) && truthy(parsed.get("options")) => {
                current_question = Some(parsed);
            }
            _ => {}
        }
    }

    let messages = Value::Array(messages);
    {
        let connection = services.tasks.connection();
        connection.execute(
            "UPDATE tasks SET planning_messages = ? WHERE id = ?",
            params![messages.to_string(), task_id],
        )?;
    }
    Ok(reply(
        200,
        json!({
            "hasUpdates": true,
            "complete": false,
            "messages": messages,
            "currentQuestion": current_question.unwrap_or(Value::Null),
        }),
    ))
}

/// `handlePlanningCompletion`: stores the spec, creates the agents, dispatches to the
/// first one, and records the outcome. A failed dispatch is kept for a retry.
async fn finish_planning(
    state: &AppState,
    services: &Services,
    task_id: &str,
    parsed: Value,
    messages: Vec<Value>,
) -> Outcome {
    let messages = Value::Array(messages);
    let spec = parsed.get("spec").map(Value::to_string);
    let agents_json = parsed.get("agents").map(Value::to_string);
    let mut first_agent_id: Option<String> = None;
    let mut dispatch_error: Option<String> = None;

    {
        let mut connection = services.tasks.connection();
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE tasks
             SET planning_messages = ?, planning_spec = ?, planning_agents = ?,
                 status = 'pending_dispatch', planning_dispatch_error = NULL
             WHERE id = ?",
            params![messages.to_string(), spec, agents_json, task_id],
        )?;
        if let Some(agents) = parsed
            .get("agents")
            .and_then(Value::as_array)
            .filter(|list| !list.is_empty())
        {
            for agent in agents {
                let agent_id = super::wire::new_id();
                first_agent_id.get_or_insert_with(|| agent_id.clone());
                transaction.execute(
                    "INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, created_at, updated_at)
                     VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, datetime('now'), datetime('now'))",
                    params![
                        agent_id,
                        task_id,
                        text_key(agent, "name"),
                        text_key(agent, "role"),
                        text_key(agent, "instructions").unwrap_or(""),
                        text_key(agent, "avatar_emoji").unwrap_or("🤖"),
                        text_key(agent, "soul_md").unwrap_or(""),
                    ],
                )?;
            }
        }
        transaction.commit()?;
    }

    // Re-check the other orchestrators before dispatching, against a race between polls.
    if first_agent_id.is_some() {
        let connection = services.tasks.connection();
        if let Some(workspace) = task_workspace(&connection, task_id)? {
            let master = query_first(
                &connection,
                "SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1",
                [workspace.as_str()],
            )?;
            let master_id = master
                .as_ref()
                .and_then(|master| text_key(master, "id"))
                .unwrap_or("");
            let others = query_rows(
                &connection,
                "SELECT id, name FROM agents
                 WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'",
                params![master_id, workspace],
            )?;
            if !others.is_empty() {
                let message = format!(
                    "Cannot auto-dispatch: {} other orchestrator(s) available in workspace",
                    others.len()
                );
                tracing::warn!("[Planning Poll] {message}");
                dispatch_error = Some(message);
                first_agent_id = None;
            }
        }
    }

    // A task that is already assigned is not dispatched twice.
    let mut skip_dispatch = false;
    if first_agent_id.is_some() {
        let assigned = {
            let connection = services.tasks.connection();
            query_first(
                &connection,
                "SELECT assigned_agent_id FROM tasks WHERE id = ?",
                [task_id],
            )?
        };
        if let Some(existing) = assigned
            .as_ref()
            .and_then(|row| text_key(row, "assigned_agent_id"))
        {
            first_agent_id = Some(existing.to_string());
            dispatch_error = None;
            skip_dispatch = true;
        }
    }

    if let (Some(agent_id), false) = (first_agent_id.clone(), skip_dispatch) {
        {
            let connection = services.tasks.connection();
            connection.execute(
                "UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime('now') WHERE id = ?",
                params![agent_id, task_id],
            )?;
        }
        let response = dispatch_task(services, state, task_id).await;
        if !(200..300).contains(&response.status) {
            dispatch_error = Some(format!(
                "Dispatch failed ({}): {}",
                response.status, response.body
            ));
        }
    }

    {
        let connection = services.tasks.connection();
        if let Some(failure) = &dispatch_error {
            connection.execute(
                "UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ?",
                params![failure, task_id],
            )?;
        } else if let Some(agent_id) = &first_agent_id {
            connection.execute(
                "UPDATE tasks
                 SET planning_complete = 1, assigned_agent_id = ?, planning_dispatch_error = NULL,
                     updated_at = datetime('now')
                 WHERE id = ?",
                params![agent_id, task_id],
            )?;
        } else {
            connection.execute(
                "UPDATE tasks
                 SET planning_complete = 1, status = 'inbox', planning_dispatch_error = NULL,
                     updated_at = datetime('now')
                 WHERE id = ?",
                [task_id],
            )?;
        }
    }

    let updated = {
        let connection = services.tasks.connection();
        planning_row(&connection, task_id)?
    };
    if let Some(task) = updated {
        notify(state, "task_updated", task);
    }

    let mut body = json!({
        "hasUpdates": true,
        "complete": true,
        "messages": messages,
        "autoDispatched": first_agent_id.is_some(),
        "dispatchError": dispatch_error,
    });
    if let Some(spec) = parsed.get("spec") {
        body["spec"] = spec.clone();
    }
    if let Some(agents) = parsed.get("agents") {
        body["agents"] = agents.clone();
    }
    if let Some(plan) = parsed.get("execution_plan") {
        body["executionPlan"] = plan.clone();
    }
    Ok(reply(200, body))
}

// ------------------------------------------------ POST /planning/retry-dispatch

/// `POST /api/tasks/{id}/planning/retry-dispatch`
pub async fn retry_dispatch(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match retry_inner(&state, &services, &access, &id).await {
        Ok(response) => response,
        Err(fault) => {
            let details = fault.0.clone();
            {
                let connection = services.tasks.connection();
                let stored = connection.execute(
                    "UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ?",
                    params![format!("Retry error: {details}"), id],
                );
                if let Err(failure) = stored {
                    tracing::error!(error = %failure, "Failed to store the retry error");
                }
            }
            tracing::error!(error = %details, "Failed to retry dispatch");
            reply(
                500,
                json!({ "error": "Failed to retry dispatch", "details": details }),
            )
        }
    }
}

async fn retry_inner(
    state: &AppState,
    services: &Services,
    access: &Access,
    task_id: &str,
) -> Outcome {
    let row = {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, task_id)? {
            return Ok(error(404, "Task not found"));
        }
        planning_row(&connection, task_id)?
    };
    let Some(row) = row else {
        return Ok(error(404, "Task not found"));
    };
    if !truthy(row.get("planning_complete")) {
        return Ok(error(
            400,
            "Cannot retry dispatch: planning is not complete",
        ));
    }
    if text_key(&row, "assigned_agent_id").is_none() {
        return Ok(error(400, "Cannot retry dispatch: no agent assigned"));
    }

    let result = dispatch_task(services, state, task_id).await;
    let failure = (!(200..300).contains(&result.status))
        .then(|| dispatch_failure_text(result.status, &result.body));
    {
        let connection = services.tasks.connection();
        match &failure {
            None => connection.execute(
                "UPDATE tasks SET planning_dispatch_error = NULL, updated_at = datetime('now') WHERE id = ?",
                [task_id],
            )?,
            Some(text) => connection.execute(
                "UPDATE tasks SET planning_dispatch_error = ?, status = 'pending_dispatch', updated_at = datetime('now') WHERE id = ?",
                params![text, task_id],
            )?,
        };
    }
    Ok(match failure {
        None => reply(
            200,
            json!({ "success": true, "message": "Dispatch retry successful" }),
        ),
        Some(details) => reply(
            500,
            json!({ "error": "Dispatch retry failed", "details": details }),
        ),
    })
}

/// `String(body.error || body.message || 'Dispatch failed (HTTP n)')`.
fn dispatch_failure_text(status: u16, body: &Value) -> String {
    let chosen = [body.get("error"), body.get("message")]
        .into_iter()
        .flatten()
        .find(|value| truthy(Some(*value)));
    match chosen {
        Some(value) => js_string(value),
        None => format!("Dispatch failed (HTTP {status})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::test_support::{
        fixture, fixture_with, send, FakeRuntime, FixedSkills, Fixture,
    };
    use axum::http::{Method, StatusCode};

    async fn create_task(fixture: &Fixture) -> String {
        let (status, task) = send(
            fixture,
            Method::POST,
            "/api/tasks",
            Some("user-1"),
            Some(r#"{"title":"Plan launch","description":"Launch the page"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        task["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn extract_json_reads_plain_fenced_and_embedded_objects() {
        assert_eq!(extract_json(r#"{"a":1}"#), Some(json!({"a": 1})));
        assert_eq!(
            extract_json("Sure:\n```json\n{\"a\": 2}\n```"),
            Some(json!({"a": 2}))
        );
        assert_eq!(extract_json("text {\"a\": 3} more"), Some(json!({"a": 3})));
        assert_eq!(extract_json("no json here"), None);
    }

    #[test]
    fn session_keys_are_unique_per_run() {
        let first = planning_session_key("t1");
        let second = planning_session_key("t1");
        assert!(first.starts_with("agent:main:planning:t1:"));
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn state_before_start_is_not_started() {
        let fixture = fixture();
        let id = create_task(&fixture).await;
        let (status, body) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}/planning"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["isStarted"], false);
        assert_eq!(body["isComplete"], false);
        assert_eq!(body["messages"], json!([]));
        assert!(body["sessionKey"].is_null());
    }

    #[tokio::test]
    async fn start_sends_the_prompt_and_stores_the_session() {
        let runtime = Arc::new(FakeRuntime::answering("chat.send", json!({})));
        let fixture = fixture_with(runtime.clone(), Arc::new(FixedSkills(1)), |_| {});
        let id = create_task(&fixture).await;
        let uri = format!("/api/tasks/{id}/planning");

        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["sessionKey"]
            .as_str()
            .unwrap()
            .starts_with("agent:main:planning:"));
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(runtime.calls_to("chat.send"), 1);

        let (status, _) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "a second start is refused");

        let (_, task) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(task["status"], "planning");
    }

    #[tokio::test]
    async fn answer_needs_an_answer_and_a_started_session() {
        let fixture = fixture();
        let id = create_task(&fixture).await;
        let uri = format!("/api/tasks/{id}/planning/answer");
        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), Some("{}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Answer is required");

        let (status, body) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"answer":"A"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Planning not started");
    }

    #[tokio::test]
    async fn poll_without_new_runtime_messages_reports_no_updates() {
        let runtime = Arc::new(FakeRuntime::answering(
            "chat.history",
            json!({ "messages": [] }),
        ));
        let fixture = fixture_with(runtime, Arc::new(FixedSkills(1)), |_| {});
        let id = create_task(&fixture).await;
        let uri = format!("/api/tasks/{id}/planning");
        send(&fixture, Method::POST, &uri, Some("user-1"), None).await;

        let (status, body) = send(
            &fixture,
            Method::GET,
            &format!("{uri}/poll"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "hasUpdates": false }));
    }

    #[tokio::test]
    async fn cancel_returns_the_task_to_the_inbox() {
        let fixture = fixture_with(
            Arc::new(FakeRuntime::answering("chat.send", json!({}))),
            Arc::new(FixedSkills(1)),
            |_| {},
        );
        let id = create_task(&fixture).await;
        let uri = format!("/api/tasks/{id}/planning");
        send(&fixture, Method::POST, &uri, Some("user-1"), None).await;

        let (status, body) = send(&fixture, Method::DELETE, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        let (_, task) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(task["status"], "inbox");
    }

    #[tokio::test]
    async fn retry_dispatch_needs_completed_planning() {
        let fixture = fixture();
        let id = create_task(&fixture).await;
        let (status, body) = send(
            &fixture,
            Method::POST,
            &format!("/api/tasks/{id}/planning/retry-dispatch"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "Cannot retry dispatch: planning is not complete"
        );
    }
}
