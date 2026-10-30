//! Port of `app/api/tasks/route.ts`, `app/api/tasks/[id]/route.ts`, `activities`,
//! `deliverables`, `subagent` and `test`, with the reads of `src/server/tasks/taskService.ts`
//! and the test endpoint of `src/server/tasks/testing/service.ts`.
//!
//! The writes of a task go through `betaclaw_core::tasks::repository::TaskRepository`.
//! The list and the single-task reads select `t.*` like the source, so the JSON
//! keeps every column, including the planning columns.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use betaclaw_core::tasks::deliverables::{ensure_from_project_dir, expand_home_path};
use betaclaw_core::tasks::dispatch::prepare::task_project_dir;
use betaclaw_core::tasks::repository::find_task;
use betaclaw_core::tasks::testing::jobs::{self, TestJob};
use betaclaw_core::tasks::testing::queue::drain;
use betaclaw_core::tasks::validation::{
    validate_create_task, validate_update_task, CreateTaskInput, UpdateTaskInput, ValidationIssue,
};
use betaclaw_core::tasks::TaskError;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Map, Value};

use super::access::{agent_workspace, normalize_workspace_id, resolve, task_workspace, Access};
use super::dispatch::dispatch_task;
use super::wire::{
    body_or_null, body_strict, error, internal, new_id, notify, now_iso, query_first, query_rows,
    reply, text_key, validation_failed, Fault, Field, Fields, Issue, Outcome, TextRule,
};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::{AppState, SharedState};

/// The `tasks` row with the names and emojis of its two agents (`getTaskWithRelations`).
const TASK_SELECT: &str = "SELECT t.*,
      aa.name AS assigned_agent_name, aa.avatar_emoji AS assigned_agent_emoji,
      ca.name AS created_by_agent_name, ca.avatar_emoji AS created_by_agent_emoji
    FROM tasks t
    LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
    LEFT JOIN agents ca ON t.created_by_agent_id = ca.id";

const ACTIVITY_SELECT: &str = "SELECT a.*, ag.id AS agent_id, ag.name AS agent_name,
      ag.avatar_emoji AS agent_avatar_emoji
    FROM task_activities a
    LEFT JOIN agents ag ON a.agent_id = ag.id";

const ACTIVITY_TYPES: &[&str] = &[
    "spawned",
    "updated",
    "completed",
    "file_created",
    "status_changed",
];
const DELIVERABLE_TYPES: &[&str] = &["file", "url", "artifact"];

/// `hydrateTaskRelations`: the `assigned_agent` and `created_by_agent` objects.
fn hydrate(mut task: Value) -> Value {
    let assigned = agent_stub(
        &task,
        "assigned_agent_id",
        "assigned_agent_name",
        "assigned_agent_emoji",
    );
    let creator = agent_stub(
        &task,
        "created_by_agent_id",
        "created_by_agent_name",
        "created_by_agent_emoji",
    );
    if let Value::Object(map) = &mut task {
        if let Some(stub) = assigned {
            map.insert("assigned_agent".to_string(), stub);
        }
        if let Some(stub) = creator {
            map.insert("created_by_agent".to_string(), stub);
        }
    }
    task
}

fn agent_stub(task: &Value, id_key: &str, name_key: &str, emoji_key: &str) -> Option<Value> {
    let id = text_key(task, id_key)?;
    Some(json!({
        "id": id,
        "name": task.get(name_key).cloned().unwrap_or(Value::Null),
        "avatar_emoji": task.get(emoji_key).cloned().unwrap_or(Value::Null),
    }))
}

/// One task as the API returns it, or `None` when it does not exist.
pub fn task_json(connection: &Connection, task_id: &str) -> rusqlite::Result<Option<Value>> {
    let sql = format!("{TASK_SELECT} WHERE t.id = ?");
    Ok(query_first(connection, &sql, [task_id])?.map(hydrate))
}

/// `triggerAutomatedTaskTest`: queues the browser test of the task, unless one is queued.
pub fn trigger_automated_test(
    services: &Services,
    connection: &Connection,
    task_id: &str,
    now: &str,
) -> rusqlite::Result<()> {
    let request = jobs::request_job(connection, task_id, now)?;
    if !request.deduplicated {
        start_test_job(services, &request.job.id);
    }
    Ok(())
}

/// `enqueueTaskTestJob` followed by `drainTaskTestQueue`, which TS does not await. The
/// drain runs on a blocking thread and takes the connection once the caller has let go.
// ponytail: the drain holds the connection lock for the whole queue. Split the browser
// run from the writes once a real deliverable runner exists.
pub fn start_test_job(services: &Services, job_id: &str) {
    services.test_queue.enqueue(job_id);
    let tasks = Arc::clone(&services.tasks);
    let queue = Arc::clone(&services.test_queue);
    let runner = Arc::clone(&services.deliverable_runner);
    tokio::task::spawn_blocking(move || {
        let connection = tasks.connection();
        if let Err(fault) = drain(&connection, &queue, runner.as_ref(), &now_iso) {
            tracing::error!(%fault, "Task test queue drain failed");
        }
    });
}

/// A test job as the API returns it (`TaskTestJob`).
pub fn job_json(job: &TestJob) -> Value {
    json!({
        "id": job.id,
        "taskId": job.task_id,
        "status": job.status,
        "requestedAt": job.requested_at,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "httpStatus": job.http_status,
        "errorMessage": job.error_message,
        "result": job.result,
    })
}

fn core_issues(issues: Vec<ValidationIssue>) -> Vec<Issue> {
    issues.into_iter().map(Issue::from).collect()
}

/// `Option<Option<T>>` of a nullable field: absent, `null`, or a value.
fn nullable(field: Field<String>) -> Option<Option<String>> {
    match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Value(value) => Some(Some(value)),
    }
}

/// `CreateTaskSchema`. The enum, length and UUID rules are checked by the core validator.
fn decode_create(body: &Value) -> Result<CreateTaskInput, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let title = fields.text(map, "title", TextRule::required());
    let description = fields.text(map, "description", TextRule::optional());
    let status = fields.text(map, "status", TextRule::optional());
    let priority = fields.text(map, "priority", TextRule::optional());
    let assigned = fields.text(map, "assigned_agent_id", TextRule::optional().nullable());
    let created_by = fields.text(map, "created_by_agent_id", TextRule::optional().nullable());
    let business_id = fields.text(map, "business_id", TextRule::optional());
    let workspace_id = fields.text(map, "workspace_id", TextRule::optional());
    let due_date = fields.text(map, "due_date", TextRule::optional().nullable());
    fields.finish(CreateTaskInput {
        title: title.into_option().unwrap_or_default(),
        description: description.into_option(),
        status: status.into_option(),
        priority: priority.into_option(),
        assigned_agent_id: nullable(assigned),
        created_by_agent_id: nullable(created_by),
        business_id: business_id.into_option(),
        workspace_id: workspace_id.into_option(),
        due_date: nullable(due_date),
    })
}

/// `UpdateTaskSchema`. The core validator checks the rules the schema adds.
fn decode_update(body: &Value) -> Result<UpdateTaskInput, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let title = fields.text(map, "title", TextRule::optional());
    let description = fields.text(map, "description", TextRule::optional());
    let status = fields.text(map, "status", TextRule::optional());
    let priority = fields.text(map, "priority", TextRule::optional());
    let assigned = fields.text(map, "assigned_agent_id", TextRule::optional().nullable());
    let due_date = fields.text(map, "due_date", TextRule::optional().nullable());
    let updated_by = fields.text(map, "updated_by_agent_id", TextRule::optional());
    fields.finish(UpdateTaskInput {
        title: title.into_option(),
        description: description.into_option(),
        status: status.into_option(),
        priority: priority.into_option(),
        assigned_agent_id: nullable(assigned),
        due_date: nullable(due_date),
        updated_by_agent_id: updated_by.into_option(),
    })
}

// ---------------------------------------------------------------- /api/tasks

/// `GET /api/tasks`
pub async fn list_tasks(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_inner(&services, &access, &query)
        .unwrap_or_else(|fault| internal("Failed to fetch tasks", fault))
}

fn list_inner(services: &Services, access: &Access, query: &HashMap<String, String>) -> Outcome {
    let connection = services.tasks.connection();
    let requested = query.get("workspace_id").filter(|value| !value.is_empty());
    if let Some(workspace) = requested {
        if !access.has_workspace(&connection, workspace)? {
            return Ok(error(404, "Workspace not found"));
        }
    }
    let workspace_ids = match requested {
        Some(_) => None,
        None => Some(access.accessible_workspace_ids(&connection)?),
    };

    let mut sql = format!("{TASK_SELECT} WHERE 1=1");
    let mut values: Vec<String> = Vec::new();
    if let Some(status) = query.get("status").filter(|value| !value.is_empty()) {
        let statuses: Vec<&str> = status
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .collect();
        match statuses.len() {
            0 => {}
            1 => {
                sql.push_str(" AND t.status = ?");
                values.push(statuses[0].to_string());
            }
            count => {
                sql.push_str(&format!(
                    " AND t.status IN ({})",
                    vec!["?"; count].join(",")
                ));
                values.extend(statuses.iter().map(|item| item.to_string()));
            }
        }
    }
    if let Some(business_id) = query.get("business_id").filter(|value| !value.is_empty()) {
        sql.push_str(" AND t.business_id = ?");
        values.push(business_id.clone());
    }
    match (requested, &workspace_ids) {
        (Some(workspace), _) => {
            sql.push_str(" AND t.workspace_id = ?");
            values.push(workspace.clone());
        }
        (None, Some(ids)) if ids.is_empty() => return Ok(reply(200, json!([]))),
        (None, Some(ids)) => {
            sql.push_str(&format!(
                " AND t.workspace_id IN ({})",
                vec!["?"; ids.len()].join(", ")
            ));
            values.extend(ids.iter().cloned());
        }
        (None, None) => {}
    }
    if let Some(agent_id) = query
        .get("assigned_agent_id")
        .filter(|value| !value.is_empty())
    {
        sql.push_str(" AND t.assigned_agent_id = ?");
        values.push(agent_id.clone());
    }
    sql.push_str(" ORDER BY t.created_at DESC");

    let rows = query_rows(&connection, &sql, params_from_iter(values.iter()))?;
    Ok(reply(
        200,
        Value::Array(rows.into_iter().map(hydrate).collect()),
    ))
}

/// `POST /api/tasks`
pub async fn create_task(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    create_inner(&state, &services, &access, &body)
        .unwrap_or_else(|fault| internal("Failed to create task", fault))
}

fn create_inner(state: &AppState, services: &Services, access: &Access, body: &Bytes) -> Outcome {
    let mut input = match decode_create(&body_or_null(body)) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    if let Err(issues) = validate_create_task(&input) {
        return Ok(validation_failed(&core_issues(issues)));
    }
    let requested = input
        .workspace_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let Some(workspace_id) = normalize_workspace_id(requested) else {
        return Ok(error(404, "Workspace not found"));
    };
    {
        let connection = services.tasks.connection();
        if !access.has_workspace(&connection, &workspace_id)? {
            return Ok(error(404, "Workspace not found"));
        }
        for reference in [&input.assigned_agent_id, &input.created_by_agent_id] {
            if let Some(Some(agent_id)) = reference {
                if !agent_id.is_empty()
                    && agent_workspace(&connection, agent_id)?.as_deref()
                        != Some(workspace_id.as_str())
                {
                    return Ok(error(
                        400,
                        "Referenced agent must belong to the task workspace",
                    ));
                }
            }
        }
    }

    input.workspace_id = Some(workspace_id);
    let created = services.tasks.create_task(&services.task_root, &input)?;
    let task = {
        let connection = services.tasks.connection();
        task_json(&connection, &created.id)?.unwrap_or(Value::Null)
    };
    notify(state, "task_created", task.clone());
    Ok(reply(201, task))
}

// ---------------------------------------------------------- /api/tasks/{id}

/// `GET /api/tasks/{id}`
pub async fn get_task(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    get_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch task", fault))
}

fn get_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, id)? {
        return Ok(error(404, "Task not found"));
    }
    match task_json(&connection, id)? {
        Some(task) => Ok(reply(200, task)),
        None => Ok(error(404, "Task not found")),
    }
}

/// `PATCH /api/tasks/{id}`
pub async fn update_task(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    match update_inner(&state, &services, &access, &id, &body) {
        Ok(response) => response,
        Err(fault) => internal("Failed to update task", fault),
    }
}

fn update_inner(
    state: &SharedState,
    services: &Arc<Services>,
    access: &Access,
    id: &str,
    body: &Bytes,
) -> Outcome {
    let workspace = {
        let connection = services.tasks.connection();
        if !access.can_access_task(&connection, id)? {
            return Ok(error(404, "Task not found"));
        }
        task_workspace(&connection, id)?
    };
    let input = match decode_update(&body_or_null(body)) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    if let Err(issues) = validate_update_task(&input) {
        return Ok(validation_failed(&core_issues(issues)));
    }

    let mut referenced: Vec<&str> = Vec::new();
    if let Some(Some(agent_id)) = &input.assigned_agent_id {
        referenced.push(agent_id.as_str());
    }
    if let Some(agent_id) = &input.updated_by_agent_id {
        referenced.push(agent_id.as_str());
    }
    {
        let connection = services.tasks.connection();
        for agent_id in referenced
            .into_iter()
            .filter(|agent_id| !agent_id.is_empty())
        {
            let same_workspace = match &workspace {
                Some(workspace) => {
                    agent_workspace(&connection, agent_id)?.as_deref() == Some(workspace.as_str())
                }
                None => false,
            };
            if !same_workspace {
                return Ok(error(
                    400,
                    "Referenced agent must belong to the task workspace",
                ));
            }
        }
    }

    let result = match services.tasks.update_task(id, &input) {
        Ok(result) => result,
        Err(TaskError::NotFound) => return Ok(error(404, "Task not found")),
        Err(TaskError::NoUpdates) => return Ok(error(400, "No updates provided")),
        Err(TaskError::Forbidden(message)) => return Ok(error(403, &message)),
        Err(other) => return Err(other.into()),
    };

    let hydrated = {
        let connection = services.tasks.connection();
        let hydrated = task_json(&connection, id)?;
        if result.should_auto_test {
            let title = hydrated
                .as_ref()
                .and_then(|task| text_key(task, "title"))
                .unwrap_or(result.previous_title.as_str())
                .to_string();
            let project_dir = task_project_dir(&services.projects_path, &title);
            let now = now_iso();
            ensure_from_project_dir(&connection, id, &project_dir, &now)?;
            trigger_automated_test(services, &connection, id, &now)?;
        }
        hydrated
    };

    if let Some(task) = &hydrated {
        notify(state, "task_updated", task.clone());
    }
    if result.should_dispatch {
        let (services, state, task_id) = (Arc::clone(services), Arc::clone(state), id.to_string());
        tokio::spawn(async move {
            dispatch_task(&services, &state, &task_id).await;
        });
    }
    Ok(reply(200, hydrated.unwrap_or(Value::Null)))
}

/// `DELETE /api/tasks/{id}`
pub async fn delete_task(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    delete_inner(&state, &services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to delete task", fault))
}

fn delete_inner(state: &AppState, services: &Services, access: &Access, id: &str) -> Outcome {
    let workspace = {
        let connection = services.tasks.connection();
        let workspace = task_workspace(&connection, id)?;
        let allowed = access.can_access_task(&connection, id)?;
        match workspace {
            Some(workspace) if allowed => workspace,
            _ => return Ok(error(404, "Task not found")),
        }
    };
    match services.tasks.delete_task(&services.task_root, id) {
        Ok(()) => {}
        Err(TaskError::NotFound) => return Ok(error(404, "Task not found")),
        Err(other) => return Err(other.into()),
    }
    notify(
        state,
        "task_deleted",
        json!({ "id": id, "workspace_id": workspace }),
    );
    Ok(reply(200, json!({ "success": true })))
}

// ------------------------------------------------------ /api/tasks/{id}/test

/// `POST /api/tasks/{id}/test`: queues the test, or returns the one already queued.
pub async fn run_test(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    run_test_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to queue task test", fault))
}

fn run_test_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let request = jobs::request_job(&connection, task_id, &now_iso())?;
    let job = job_json(&request.job);
    if request.deduplicated {
        Ok(reply(
            200,
            json!({ "ok": true, "queued": true, "deduplicated": true, "job": job }),
        ))
    } else {
        start_test_job(services, &request.job.id);
        Ok(reply(
            202,
            json!({ "ok": true, "queued": true, "job": job }),
        ))
    }
}

/// `GET /api/tasks/{id}/test`, or one job of it with `?jobId=`.
pub async fn test_info(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    let job_id = query.get("jobId").map(|value| value.trim().to_string());
    test_info_inner(
        &services,
        &access,
        &id,
        job_id.filter(|value| !value.is_empty()),
    )
    .unwrap_or_else(|fault| internal("Failed to read task tests", fault))
}

fn test_info_inner(
    services: &Services,
    access: &Access,
    task_id: &str,
    job_id: Option<String>,
) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let Some(task) = find_task(&connection, task_id)? else {
        return Ok(error(404, "Task not found"));
    };

    if let Some(job_id) = job_id {
        return Ok(match jobs::job_for_task(&connection, task_id, &job_id)? {
            Some(job) => reply(
                200,
                json!({
                    "ok": true,
                    "taskId": task_id,
                    "taskTitle": task.title,
                    "job": job_json(&job),
                }),
            ),
            None => error(404, "Task test job not found"),
        });
    }

    let deliverables = query_rows(
        &connection,
        "SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)",
        params![task_id, "file", "url"],
    )?;
    let testable_files: Vec<Value> = deliverables
        .iter()
        .filter(|item| {
            item["deliverable_type"] == "file"
                && item["path"]
                    .as_str()
                    .is_some_and(|path| path.ends_with(".html") || path.ends_with(".htm"))
        })
        .map(|item| json!({ "id": item["id"], "title": item["title"], "path": item["path"] }))
        .collect();
    let testable_urls: Vec<Value> = deliverables
        .iter()
        .filter(|item| item["deliverable_type"] == "url")
        .map(|item| json!({ "id": item["id"], "title": item["title"], "path": item["path"] }))
        .collect();
    let latest = jobs::latest_job(&connection, task_id)?
        .map(|job| job_json(&job))
        .unwrap_or(Value::Null);
    let active = jobs::active_job(&connection, task_id)?
        .map(|job| job_json(&job))
        .unwrap_or(Value::Null);

    Ok(reply(
        200,
        json!({
            "taskId": task_id,
            "taskTitle": task.title,
            "taskStatus": task.status,
            "deliverableCount": deliverables.len(),
            "testableFiles": testable_files,
            "testableUrls": testable_urls,
            "queue": { "activeJob": active, "latestJob": latest },
            "validations": [
                "JavaScript console error detection",
                "CSS syntax validation (via css-tree)",
                "Resource loading validation (images, scripts, stylesheets)",
                "HTTP status code validation (for URL deliverables)",
            ],
            "workflow": {
                "expectedStatus": "testing",
                "onPass": "Moves to review for human approval",
                "onFail": "Moves to assigned for agent to fix issues",
            },
            "usage": {
                "post": {
                    "method": "POST",
                    "description": "Queue automated browser tests for all HTML/URL deliverables",
                    "returns": "Accepted job payload with status=queued",
                },
                "get": {
                    "method": "GET",
                    "description": "Read endpoint info and latest/active queue state",
                },
                "getJob": {
                    "method": "GET",
                    "query": { "jobId": "task-test-job-id" },
                    "description": "Read a specific queued/running/completed test job",
                },
            },
        }),
    ))
}

// ------------------------------------------------- /api/tasks/{id}/activities

fn non_null<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key).filter(|value| !value.is_null())
}

/// `TaskActivity` of one joined row. `agent_id` and `metadata` are omitted when null, as
/// `JSON.stringify` drops `undefined`.
fn activity_json(row: &Value) -> Value {
    let mut activity = Map::new();
    activity.insert("id".to_string(), row["id"].clone());
    activity.insert("task_id".to_string(), row["task_id"].clone());
    let agent_id = non_null(row, "agent_id");
    if let Some(agent_id) = agent_id {
        activity.insert("agent_id".to_string(), agent_id.clone());
    }
    activity.insert("activity_type".to_string(), row["activity_type"].clone());
    activity.insert("message".to_string(), row["message"].clone());
    if let Some(metadata) = non_null(row, "metadata") {
        activity.insert("metadata".to_string(), metadata.clone());
    }
    activity.insert("created_at".to_string(), row["created_at"].clone());
    if let Some(agent_id) = agent_id {
        let name = non_null(row, "agent_name")
            .cloned()
            .unwrap_or_else(|| json!("Unknown Agent"));
        let emoji = non_null(row, "agent_avatar_emoji")
            .cloned()
            .unwrap_or_else(|| json!("🤖"));
        activity.insert(
            "agent".to_string(),
            json!({
                "id": agent_id,
                "name": name,
                "avatar_emoji": emoji,
                "role": "",
                "status": "working",
                "is_master": false,
                "workspace_id": "default",
                "source": "local",
                "description": "",
                "created_at": "",
                "updated_at": "",
            }),
        );
    }
    Value::Object(activity)
}

/// `GET /api/tasks/{id}/activities`
pub async fn list_activities(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_activities_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch activities", fault))
}

fn list_activities_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let sql = format!("{ACTIVITY_SELECT} WHERE a.task_id = ? ORDER BY a.created_at DESC");
    let rows = query_rows(&connection, &sql, [task_id])?;
    Ok(reply(
        200,
        Value::Array(rows.iter().map(activity_json).collect()),
    ))
}

/// `CreateActivitySchema`.
struct ActivityInput {
    activity_type: String,
    message: String,
    agent_id: Option<String>,
    metadata: Option<String>,
}

fn decode_activity(body: &Value) -> Result<ActivityInput, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let activity_type = fields.one_of(map, "activity_type", ACTIVITY_TYPES, TextRule::required());
    let message = fields.text(map, "message", TextRule::required().length(1, 5000));
    let agent_id = fields.uuid(map, "agent_id", false);
    let metadata = fields.text(map, "metadata", TextRule::optional());
    fields.finish(ActivityInput {
        activity_type: activity_type.into_option().unwrap_or_default(),
        message: message.into_option().unwrap_or_default(),
        agent_id: agent_id.into_option(),
        metadata: metadata.into_option(),
    })
}

/// `POST /api/tasks/{id}/activities`
pub async fn create_activity(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    create_activity_inner(&state, &services, &access, &id, &body)
        .unwrap_or_else(|fault| internal("Failed to create activity", fault))
}

fn create_activity_inner(
    state: &AppState,
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
    let input = match decode_activity(&body) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };

    let connection = services.tasks.connection();
    if let Some(agent_id) = &input.agent_id {
        let task_ws = task_workspace(&connection, task_id)?;
        let agent_ws = agent_workspace(&connection, agent_id)?;
        if let (Some(task_ws), Some(agent_ws)) = (&task_ws, &agent_ws) {
            if task_ws != agent_ws {
                return Ok(error(
                    400,
                    "Referenced agent must belong to the task workspace",
                ));
            }
        }
    }
    let Some(task) = query_first(
        &connection,
        "SELECT id, assigned_agent_id FROM tasks WHERE id = ?",
        [task_id],
    )?
    else {
        return Ok(error(404, "Task not found"));
    };
    let assigned = text_key(&task, "assigned_agent_id").map(str::to_string);
    let resolved_agent = match input.agent_id.as_deref() {
        Some(agent_id) => {
            let exists = query_first(
                &connection,
                "SELECT id FROM agents WHERE id = ?",
                [agent_id],
            )?
            .is_some();
            if exists {
                Some(agent_id.to_string())
            } else {
                assigned
            }
        }
        None => None,
    };
    let metadata = match input.metadata {
        Some(metadata) if !metadata.is_empty() => Some(serde_json::to_string(&metadata)?),
        _ => None,
    };

    let id = new_id();
    connection.execute(
        "INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            id,
            task_id,
            resolved_agent,
            input.activity_type,
            input.message,
            metadata
        ],
    )?;
    let sql = format!("{ACTIVITY_SELECT} WHERE a.id = ?");
    let Some(row) = query_first(&connection, &sql, [id.as_str()])? else {
        return Ok(error(500, "Failed to load created activity"));
    };
    drop(connection);

    let activity = activity_json(&row);
    notify(state, "activity_logged", activity.clone());
    Ok(reply(201, activity))
}

// ----------------------------------------------- /api/tasks/{id}/deliverables

/// `GET /api/tasks/{id}/deliverables`
pub async fn list_deliverables(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_deliverables_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch deliverables", fault))
}

fn list_deliverables_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let rows = query_rows(
        &connection,
        "SELECT * FROM task_deliverables WHERE task_id = ? ORDER BY created_at DESC",
        [task_id],
    )?;
    Ok(reply(200, Value::Array(rows)))
}

/// `CreateDeliverableSchema`.
struct DeliverableInput {
    deliverable_type: String,
    title: String,
    path: Option<String>,
    description: Option<String>,
}

fn decode_deliverable(body: &Value) -> Result<DeliverableInput, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let deliverable_type = fields.one_of(
        map,
        "deliverable_type",
        DELIVERABLE_TYPES,
        TextRule::required(),
    );
    let title = fields.text(map, "title", TextRule::required().length(1, usize::MAX));
    let path = fields.text(map, "path", TextRule::optional());
    let description = fields.text(map, "description", TextRule::optional());
    fields.finish(DeliverableInput {
        deliverable_type: deliverable_type.into_option().unwrap_or_default(),
        title: title.into_option().unwrap_or_default(),
        path: path.into_option(),
        description: description.into_option(),
    })
}

/// `POST /api/tasks/{id}/deliverables`
pub async fn create_deliverable(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    create_deliverable_inner(&state, &services, &access, &id, &body)
        .unwrap_or_else(|fault| internal("Failed to create deliverable", fault))
}

fn create_deliverable_inner(
    state: &AppState,
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
    let input = match decode_deliverable(&body) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };

    let path = input.path.filter(|value| !value.is_empty());
    let mut warning = None;
    if input.deliverable_type == "file" {
        if let Some(path) = &path {
            let expanded = expand_home_path(path);
            if !Path::new(&expanded).exists() {
                tracing::warn!(path = %expanded, "[DELIVERABLE] Warning: File does not exist");
                warning = Some(format!(
                    "File does not exist at path: {expanded}. Please create the file."
                ));
            }
        }
    }

    let id = new_id();
    let connection = services.tasks.connection();
    connection.execute(
        "INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            id,
            task_id,
            input.deliverable_type,
            input.title,
            path,
            input.description.filter(|value| !value.is_empty())
        ],
    )?;
    let mut deliverable = query_first(
        &connection,
        "SELECT * FROM task_deliverables WHERE id = ?",
        [id.as_str()],
    )?
    .unwrap_or(Value::Null);
    drop(connection);

    notify(state, "deliverable_added", deliverable.clone());
    if let (Some(warning), Value::Object(map)) = (warning, &mut deliverable) {
        map.insert("warning".to_string(), json!(warning));
    }
    Ok(reply(201, deliverable))
}

// ---------------------------------------------------- /api/tasks/{id}/subagent

/// `GET /api/tasks/{id}/subagent`
pub async fn list_subagents(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_subagents_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch sub-agents", fault))
}

fn list_subagents_inner(services: &Services, access: &Access, task_id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if !access.can_access_task(&connection, task_id)? {
        return Ok(error(404, "Task not found"));
    }
    let rows = query_rows(
        &connection,
        "SELECT s.*, a.name AS agent_name, a.avatar_emoji AS agent_avatar_emoji
         FROM betaclaw_sessions s
         LEFT JOIN agents a ON s.agent_id = a.id
         WHERE s.task_id = ? AND s.session_type = 'subagent'
         ORDER BY s.created_at DESC",
        [task_id],
    )?;
    Ok(reply(200, Value::Array(rows)))
}

/// `POST /api/tasks/{id}/subagent`
pub async fn register_subagent(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    register_subagent_inner(&state, &services, &access, &id, &body)
        .unwrap_or_else(|fault| internal("Failed to register sub-agent", fault))
}

fn register_subagent_inner(
    state: &AppState,
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
    if !body.is_object() {
        return Err(Fault("request body is not an object".to_string()));
    }
    let Some(session_id) = text_key(&body, "betaclaw_session_id") else {
        return Ok(error(400, "betaclaw_session_id is required"));
    };
    let agent_name = text_key(&body, "agent_name");

    let connection = services.tasks.connection();
    let mut agent_id: Option<String> = None;
    if let Some(name) = agent_name {
        let workspace = task_workspace(&connection, task_id)?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "default".to_string());
        let existing = query_first(
            &connection,
            "SELECT id FROM agents WHERE name = ? AND workspace_id = ?",
            params![name, workspace],
        )?
        .and_then(|row| row.get("id").and_then(Value::as_str).map(str::to_string));
        agent_id = Some(match existing {
            Some(existing) => existing,
            None => {
                let created = new_id();
                connection.execute(
                    "INSERT INTO agents (id, name, role, description, status, workspace_id)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    params![
                        created,
                        name,
                        "Sub-Agent",
                        "Automatically created sub-agent",
                        "working",
                        workspace
                    ],
                )?;
                created
            }
        });
    }

    let session_row_id = new_id();
    connection.execute(
        "INSERT INTO betaclaw_sessions (id, agent_id, betaclaw_session_id, session_type, task_id, status)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            session_row_id,
            agent_id,
            session_id,
            "subagent",
            task_id,
            "active"
        ],
    )?;
    let session = query_first(
        &connection,
        "SELECT * FROM betaclaw_sessions WHERE id = ?",
        [session_row_id.as_str()],
    )?
    .unwrap_or(Value::Null);
    drop(connection);

    let mut payload = json!({ "taskId": task_id, "sessionId": session_id });
    if let (Some(name), Value::Object(map)) = (agent_name, &mut payload) {
        map.insert("agentName".to_string(), json!(name));
    }
    notify(state, "agent_spawned", payload);
    Ok(reply(201, session))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::test_support::{fixture, send, Fixture};
    use axum::http::{Method, StatusCode};

    async fn create(fixture: &Fixture, title: &str) -> String {
        let (status, body) = send(
            fixture,
            Method::POST,
            "/api/tasks",
            Some("user-1"),
            Some(&json!({ "title": title }).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        body["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn task_create_get_and_list_roundtrip() {
        let fixture = fixture();
        let id = create(&fixture, "Write docs").await;

        let (status, body) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["title"], "Write docs");
        assert_eq!(body["status"], "inbox");
        assert_eq!(body["priority"], "normal");
        assert_eq!(body["workspace_id"], "default");
        assert!(
            body.get("planning_session_key").is_some(),
            "t.* keeps the planning columns"
        );

        let (status, list) = send(
            &fixture,
            Method::GET,
            "/api/tasks?status=inbox",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn create_rejects_a_missing_title_with_details() {
        let fixture = fixture();
        let (status, body) = send(
            &fixture,
            Method::POST,
            "/api/tasks",
            Some("user-1"),
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Validation failed");
        assert_eq!(body["details"][0]["path"], json!(["title"]));
    }

    #[tokio::test]
    async fn patch_without_fields_is_a_bad_request() {
        let fixture = fixture();
        let id = create(&fixture, "Patch me").await;
        let (status, body) = send(
            &fixture,
            Method::PATCH,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "No updates provided");
    }

    #[tokio::test]
    async fn status_change_is_applied_and_returned() {
        let fixture = fixture();
        let id = create(&fixture, "Move me").await;
        let (status, body) = send(
            &fixture,
            Method::PATCH,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            Some(r#"{"status":"review"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "review");
    }

    #[tokio::test]
    async fn delete_removes_the_task() {
        let fixture = fixture();
        let id = create(&fixture, "Delete me").await;
        let (status, body) = send(
            &fixture,
            Method::DELETE,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["success"], true);
        let (status, _) = send(
            &fixture,
            Method::GET,
            &format!("/api/tasks/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn activity_is_logged_and_listed_newest_first() {
        let fixture = fixture();
        let id = create(&fixture, "Log me").await;
        let uri = format!("/api/tasks/{id}/activities");
        let (status, body) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"activity_type":"updated","message":"step one"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["task_id"], id.as_str());
        assert_eq!(body["message"], "step one");
        assert!(body.get("agent").is_none(), "no agent, no agent object");

        let (status, list) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);

        let (status, body) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"activity_type":"sleeping","message":"x"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Validation failed");
    }

    #[tokio::test]
    async fn file_deliverable_without_a_file_carries_a_warning() {
        let fixture = fixture();
        let id = create(&fixture, "Deliver").await;
        let uri = format!("/api/tasks/{id}/deliverables");
        let (status, body) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"deliverable_type":"file","title":"Page","path":"/no/such/betaclaw/page.html"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(body["warning"]
            .as_str()
            .unwrap()
            .starts_with("File does not exist at path:"));

        let (status, list) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn subagent_registration_needs_a_session_id() {
        let fixture = fixture();
        let id = create(&fixture, "Spawn").await;
        let uri = format!("/api/tasks/{id}/subagent");
        let (status, body) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"agent_name":"Scout"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "betaclaw_session_id is required");

        let (status, session) = send(
            &fixture,
            Method::POST,
            &uri,
            Some("user-1"),
            Some(r#"{"betaclaw_session_id":"s-1","agent_name":"Scout"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(session["session_type"], "subagent");
        assert_eq!(session["betaclaw_session_id"], "s-1");
        assert!(
            session["agent_id"].is_string(),
            "the placeholder agent is linked"
        );

        let (status, list) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    /// Polls the job until the drain has finished it, and returns the job.
    async fn wait_for_finished_job(fixture: &Fixture, task_id: &str, job_id: &str) -> Value {
        let uri = format!("/api/tasks/{task_id}/test?jobId={job_id}");
        for _ in 0..500 {
            let (_, body) = send(fixture, Method::GET, &uri, Some("user-1"), None).await;
            let status = body["job"]["status"].as_str().unwrap_or_default();
            if status == "completed" || status == "failed" {
                return body["job"].clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the drain did not finish job {job_id}");
    }

    #[tokio::test]
    async fn a_queued_test_job_is_drained_and_frees_the_dedupe() {
        let fixture = fixture();
        let id = create(&fixture, "Test me").await;
        let uri = format!("/api/tasks/{id}/test");
        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(body["job"]["status"], "queued");
        let job_id = body["job"]["id"].as_str().unwrap().to_string();

        // The task has no file or url deliverable, so the drain fails the job at once.
        let job = wait_for_finished_job(&fixture, &id, &job_id).await;
        assert_eq!(job["status"], "failed");
        assert_eq!(job["httpStatus"], 400);
        assert_eq!(
            job["errorMessage"],
            "No testable deliverables found (file or url types)"
        );

        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_ne!(body["job"]["id"], job_id);
    }

    #[tokio::test]
    async fn an_active_test_job_is_returned_instead_of_a_new_one() {
        let fixture = fixture();
        let id = create(&fixture, "Test me").await;
        // A queued job that the in-memory queue does not hold is never drained, so it stays queued.
        let queued = {
            let connection = fixture.services.tasks.connection();
            jobs::create_job(&connection, &id, &now_iso()).unwrap()
        };
        let uri = format!("/api/tasks/{id}/test");
        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deduplicated"], true);
        assert_eq!(body["job"]["id"], queued.id);

        let (status, info) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(info["queue"]["activeJob"]["status"], "queued");
        assert_eq!(info["deliverableCount"], 0);
    }
}
