//! Port of `app/api/agents/route.ts`, `discover/route.ts`, `import/route.ts`,
//! `[id]/route.ts` and `[id]/betaclaw/route.ts`.
//!
//! The agent table is read and written here with SQL, as the source does. The
//! Rust agent registry in `betaclaw_core::agents` holds only the sub-agent runs.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, Path as AxumPath, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use betaclaw_core::tasks::dispatch::prepare::dispatch_session_id;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Map, Value};

use super::access::{normalize_workspace_id, resolve, Access};
use super::wire::{
    body_or_null, body_strict, error, internal, new_id, now_iso, query_first, query_rows, reply,
    text_key, validation_failed, Field, Fields, Issue, Outcome, TextRule,
};
use super::Services;
use crate::auth_gate::unauthorized_response;
use crate::state::SharedState;

const AGENT_STATUSES: &[&str] = &["standby", "working", "offline"];

/// `CreateAgentSchema`.
struct NewAgent {
    name: String,
    role: String,
    description: Field<String>,
    avatar_emoji: Option<String>,
    is_master: Option<bool>,
    workspace_id: Option<String>,
    soul_md: Field<String>,
    user_md: Field<String>,
    agents_md: Field<String>,
    model: Field<String>,
}

fn decode_create(body: &Value) -> Result<NewAgent, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let name = fields.text(map, "name", TextRule::required().trimmed().length(1, 120));
    let role = fields.text(map, "role", TextRule::required().trimmed().length(1, 240));
    let description = fields.text(
        map,
        "description",
        TextRule::optional().nullable().length(0, 4000),
    );
    let avatar_emoji = fields.text(
        map,
        "avatar_emoji",
        TextRule::optional().trimmed().length(1, 16),
    );
    let is_master = fields.boolean(map, "is_master");
    let workspace_id = fields.text(
        map,
        "workspace_id",
        TextRule::optional().trimmed().length(1, usize::MAX),
    );
    let soul_md = fields.text(
        map,
        "soul_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let user_md = fields.text(
        map,
        "user_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let agents_md = fields.text(
        map,
        "agents_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let model = fields.text(map, "model", TextRule::optional().nullable().length(0, 400));
    fields.finish(NewAgent {
        name: name.into_option().unwrap_or_default(),
        role: role.into_option().unwrap_or_default(),
        description,
        avatar_emoji: avatar_emoji.into_option(),
        is_master: is_master.into_option(),
        workspace_id: workspace_id.into_option(),
        soul_md,
        user_md,
        agents_md,
        model,
    })
}

/// `UpdateAgentSchema`. Each field keeps `null` apart from an absent key.
struct AgentPatch {
    name: Field<String>,
    role: Field<String>,
    description: Field<String>,
    avatar_emoji: Field<String>,
    status: Field<String>,
    is_master: Field<bool>,
    soul_md: Field<String>,
    user_md: Field<String>,
    agents_md: Field<String>,
    model: Field<String>,
}

fn decode_update(body: &Value) -> Result<AgentPatch, Vec<Issue>> {
    let mut fields = Fields::default();
    let Some(map) = fields.object(body) else {
        return Err(fields.into_issues());
    };
    let name = fields.text(map, "name", TextRule::optional().trimmed().length(1, 120));
    let role = fields.text(map, "role", TextRule::optional().trimmed().length(1, 240));
    let description = fields.text(
        map,
        "description",
        TextRule::optional().nullable().length(0, 4000),
    );
    let avatar_emoji = fields.text(
        map,
        "avatar_emoji",
        TextRule::optional().trimmed().length(1, 16),
    );
    let status = fields.one_of(map, "status", AGENT_STATUSES, TextRule::optional());
    let is_master = fields.boolean(map, "is_master");
    let soul_md = fields.text(
        map,
        "soul_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let user_md = fields.text(
        map,
        "user_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let agents_md = fields.text(
        map,
        "agents_md",
        TextRule::optional().nullable().length(0, 20000),
    );
    let model = fields.text(map, "model", TextRule::optional().nullable().length(0, 400));
    fields.finish(AgentPatch {
        name,
        role,
        description,
        avatar_emoji,
        status,
        is_master,
        soul_md,
        user_md,
        agents_md,
        model,
    })
}

/// A text value for a nullable column: the empty string is stored as NULL (`x || null`).
fn text_or_null(text: &str) -> SqlValue {
    if text.is_empty() {
        SqlValue::Null
    } else {
        SqlValue::Text(text.to_string())
    }
}

/// A decoded nullable field as a column value.
fn field_or_null(field: &Field<String>) -> SqlValue {
    match field {
        Field::Value(text) => text_or_null(text),
        Field::Null | Field::Absent => SqlValue::Null,
    }
}

fn agent_by_id(connection: &Connection, id: &str) -> rusqlite::Result<Option<Value>> {
    query_first(connection, "SELECT * FROM agents WHERE id = ?", [id])
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

// ----------------------------------------------------------- /api/agents

/// `GET /api/agents?workspace_id=`
pub async fn list_agents(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    list_inner(&services, &access, &query)
        .unwrap_or_else(|fault| internal("Failed to fetch agents", fault))
}

fn list_inner(services: &Services, access: &Access, query: &HashMap<String, String>) -> Outcome {
    let connection = services.tasks.connection();
    let requested = query.get("workspace_id").filter(|value| !value.is_empty());
    if let Some(workspace) = requested {
        if !access.has_workspace(&connection, workspace)? {
            return Ok(error(404, "Workspace not found"));
        }
    }
    let ids = match requested {
        Some(workspace) => vec![workspace.clone()],
        None => access.accessible_workspace_ids(&connection)?,
    };
    if ids.is_empty() {
        return Ok(reply(200, json!([])));
    }
    let sql = format!(
        "SELECT * FROM agents WHERE workspace_id IN ({}) ORDER BY is_master DESC, name ASC",
        placeholders(ids.len())
    );
    let rows = query_rows(&connection, &sql, params_from_iter(ids.iter()))?;
    Ok(reply(200, Value::Array(rows)))
}

/// `POST /api/agents`
pub async fn create_agent(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    create_inner(&services, &access, &body)
        .unwrap_or_else(|fault| internal("Failed to create agent", fault))
}

fn create_inner(services: &Services, access: &Access, body: &Bytes) -> Outcome {
    let input = match decode_create(&body_or_null(body)) {
        Ok(input) => input,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    let requested = input
        .workspace_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let Some(workspace_id) = normalize_workspace_id(requested) else {
        return Ok(error(404, "Workspace not found"));
    };
    let connection = services.tasks.connection();
    if !access.has_workspace(&connection, &workspace_id)? {
        return Ok(error(404, "Workspace not found"));
    }

    let id = new_id();
    let now = now_iso();
    let avatar = input.avatar_emoji.unwrap_or_else(|| "🤖".to_string());
    connection.execute(
        "INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            input.name,
            input.role,
            field_or_null(&input.description),
            avatar,
            i64::from(input.is_master.unwrap_or(false)),
            workspace_id,
            field_or_null(&input.soul_md),
            field_or_null(&input.user_md),
            field_or_null(&input.agents_md),
            field_or_null(&input.model),
            now,
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
        params![
            new_id(),
            "agent_joined",
            id,
            format!("{} joined the team", input.name),
            now
        ],
    )?;
    let row = agent_by_id(&connection, &id)?.unwrap_or(Value::Null);
    Ok(reply(201, row))
}

// ------------------------------------------------------ /api/agents/discover

/// `GET /api/agents/discover?workspace_id=`: the agents of the runtime registry, with the
/// ones already imported marked.
pub async fn discover_agents(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    discover_inner(&services, &access, &query)
        .await
        .unwrap_or_else(|fault| internal("Failed to discover agents from runtime registry", fault))
}

async fn discover_inner(
    services: &Services,
    access: &Access,
    query: &HashMap<String, String>,
) -> Outcome {
    let requested = query
        .get("workspace_id")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .unwrap_or("default");
    let Some(workspace) = normalize_workspace_id(requested) else {
        return Ok(error(404, "Workspace not found"));
    };
    {
        let connection = services.tasks.connection();
        if !access.has_workspace(&connection, &workspace)? {
            return Ok(error(404, "Workspace not found"));
        }
    }
    if services.ensure_connected().await.is_err() {
        return Ok(error(503, "Failed to connect to Mission Control runtime"));
    }
    let listed = match services.runtime.call("agents.list", json!({})).await {
        Ok(listed) => listed,
        Err(failure) => {
            tracing::error!(%failure, "Failed to list agents from runtime registry");
            return Ok(error(502, "Failed to list agents from runtime registry"));
        }
    };
    let Value::Array(items) = listed else {
        return Ok(error(502, "Unexpected response from runtime agents.list"));
    };

    let rows = {
        let connection = services.tasks.connection();
        query_rows(
            &connection,
            "SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL AND workspace_id = ?",
            [workspace.as_str()],
        )?
    };
    let imported: HashMap<String, String> = rows
        .iter()
        .filter_map(|row| {
            let gateway_id = text_key(row, "gateway_agent_id")?.to_string();
            let agent_id = text_key(row, "id")?.to_string();
            Some((gateway_id, agent_id))
        })
        .collect();

    let mut already_imported = 0usize;
    let mut discovered = Vec::with_capacity(items.len());
    for item in &items {
        let gateway_id = text_key(item, "id")
            .or_else(|| text_key(item, "name"))
            .unwrap_or("")
            .to_string();
        let name = text_key(item, "name")
            .or_else(|| text_key(item, "label"))
            .unwrap_or(gateway_id.as_str())
            .to_string();
        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(gateway_id));
        entry.insert("name".to_string(), json!(name));
        for key in ["label", "model", "channel", "status"] {
            if let Some(value) = item.get(key) {
                entry.insert(key.to_string(), value.clone());
            }
        }
        let existing = imported.get(&gateway_id);
        entry.insert("already_imported".to_string(), json!(existing.is_some()));
        if let Some(agent_id) = existing {
            entry.insert("existing_agent_id".to_string(), json!(agent_id));
            already_imported += 1;
        }
        discovered.push(Value::Object(entry));
    }

    Ok(reply(
        200,
        json!({
            "agents": discovered,
            "total": items.len(),
            "already_imported": already_imported,
        }),
    ))
}

// ------------------------------------------------------- /api/agents/import

/// `POST /api/agents/import`: creates one agent per runtime agent that is not imported yet.
pub async fn import_agents(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    import_inner(&services, &access, &body)
        .unwrap_or_else(|fault| internal("Failed to import agents", fault))
}

fn import_inner(services: &Services, access: &Access, body: &Bytes) -> Outcome {
    let body = body_strict(body)?;
    let Some(object) = body.as_object() else {
        return Err(super::wire::Fault(
            "request body is not an object".to_string(),
        ));
    };
    let agents = match object.get("agents").and_then(Value::as_array) {
        Some(agents) if !agents.is_empty() => agents,
        _ => {
            return Ok(error(
                400,
                "At least one agent is required in the agents array",
            ))
        }
    };
    if agents.iter().any(|agent| {
        text_key(agent, "gateway_agent_id").is_none() || text_key(agent, "name").is_none()
    }) {
        return Ok(error(400, "Each agent must have gateway_agent_id and name"));
    }

    let mut workspaces = Vec::with_capacity(agents.len());
    for agent in agents {
        let requested = text_key(agent, "workspace_id").unwrap_or("default");
        match normalize_workspace_id(requested) {
            Some(workspace) => workspaces.push(workspace),
            None => return Ok(error(404, "Workspace not found")),
        }
    }
    let mut connection = services.tasks.connection();
    for workspace in &workspaces {
        if !access.has_workspace(&connection, workspace)? {
            return Ok(error(404, "Workspace not found"));
        }
    }

    let mut distinct = workspaces.clone();
    distinct.sort();
    distinct.dedup();
    let known_rows = query_rows(
        &connection,
        &format!(
            "SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL AND workspace_id IN ({})",
            placeholders(distinct.len())
        ),
        params_from_iter(distinct.iter()),
    )?;
    let existing: Vec<String> = known_rows
        .iter()
        .filter_map(|row| text_key(row, "gateway_agent_id").map(str::to_string))
        .collect();

    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let transaction = connection.transaction()?;
    let now = now_iso();
    for (agent, workspace) in agents.iter().zip(&workspaces) {
        let gateway_id = text_key(agent, "gateway_agent_id").unwrap_or("");
        let name = text_key(agent, "name").unwrap_or("");
        if existing.iter().any(|known| known == gateway_id) {
            skipped.push(json!({ "gateway_agent_id": gateway_id, "reason": "Already imported" }));
            continue;
        }
        let id = new_id();
        transaction.execute(
            "INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, model, source, gateway_agent_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                name,
                "Imported Agent",
                format!("Imported from runtime registry ({gateway_id})"),
                "🔗",
                0,
                workspace,
                text_key(agent, "model"),
                "gateway",
                gateway_id,
                now,
                now
            ],
        )?;
        transaction.execute(
            "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                new_id(),
                "agent_joined",
                id,
                format!("{name} imported from runtime registry"),
                now
            ],
        )?;
        if let Some(row) = agent_by_id(&transaction, &id)? {
            imported.push(row);
        }
    }
    transaction.commit()?;
    Ok(reply(
        201,
        json!({ "imported": imported, "skipped": skipped }),
    ))
}

// ------------------------------------------------------- /api/agents/{id}

/// `GET /api/agents/{id}`
pub async fn get_agent(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    get_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to fetch agent", fault))
}

fn get_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    let Some(row) = agent_by_id(&connection, id)? else {
        return Ok(error(404, "Agent not found"));
    };
    if !access.can_access_agent(&connection, id)? {
        return Ok(error(404, "Agent not found"));
    }
    Ok(reply(200, row))
}

/// `PATCH /api/agents/{id}`
pub async fn update_agent(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body: Bytes,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    update_inner(&services, &access, &id, &body)
        .unwrap_or_else(|fault| internal("Failed to update agent", fault))
}

fn update_inner(services: &Services, access: &Access, id: &str, body: &Bytes) -> Outcome {
    let patch = match decode_update(&body_or_null(body)) {
        Ok(patch) => patch,
        Err(issues) => return Ok(validation_failed(&issues)),
    };
    let connection = services.tasks.connection();
    let Some(existing) = agent_by_id(&connection, id)? else {
        return Ok(error(404, "Agent not found"));
    };
    if !access.can_access_agent(&connection, id)? {
        return Ok(error(404, "Agent not found"));
    }
    let existing_name = text_key(&existing, "name").unwrap_or("").to_string();

    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Field::Value(name) = patch.name {
        sets.push("name = ?");
        values.push(SqlValue::Text(name));
    }
    if let Field::Value(role) = patch.role {
        sets.push("role = ?");
        values.push(SqlValue::Text(role));
    }
    if !matches!(patch.description, Field::Absent) {
        sets.push("description = ?");
        values.push(field_or_null(&patch.description));
    }
    if let Field::Value(emoji) = patch.avatar_emoji {
        sets.push("avatar_emoji = ?");
        values.push(SqlValue::Text(emoji));
    }
    if let Field::Value(status) = patch.status {
        sets.push("status = ?");
        connection.execute(
            "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
            params![
                new_id(),
                "agent_status_changed",
                id,
                format!("{existing_name} is now {status}"),
                now_iso()
            ],
        )?;
        values.push(SqlValue::Text(status));
    }
    if let Field::Value(master) = patch.is_master {
        sets.push("is_master = ?");
        values.push(SqlValue::Integer(i64::from(master)));
    }
    for (clause, field) in [
        ("soul_md = ?", &patch.soul_md),
        ("user_md = ?", &patch.user_md),
        ("agents_md = ?", &patch.agents_md),
        ("model = ?", &patch.model),
    ] {
        if !matches!(field, Field::Absent) {
            sets.push(clause);
            values.push(field_or_null(field));
        }
    }
    if sets.is_empty() {
        return Ok(error(400, "No updates provided"));
    }
    sets.push("updated_at = ?");
    values.push(SqlValue::Text(now_iso()));
    values.push(SqlValue::Text(id.to_string()));

    let sql = format!("UPDATE agents SET {} WHERE id = ?", sets.join(", "));
    connection.execute(&sql, params_from_iter(values.iter()))?;
    let row = agent_by_id(&connection, id)?.unwrap_or(Value::Null);
    Ok(reply(200, row))
}

/// `DELETE /api/agents/{id}`. The tasks keep their rows and lose the agent reference. The
/// agent's messages and conversation memberships go too: both tables live in mission-control.db
/// (`migration_runner` creates them there), and `messages.sender_agent_id` would block the delete.
pub async fn delete_agent(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    delete_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to delete agent", fault))
}

fn delete_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if agent_by_id(&connection, id)?.is_none() {
        return Ok(error(404, "Agent not found"));
    }
    if !access.can_access_agent(&connection, id)? {
        return Ok(error(404, "Agent not found"));
    }
    connection.execute("DELETE FROM betaclaw_sessions WHERE agent_id = ?", [id])?;
    connection.execute("DELETE FROM events WHERE agent_id = ?", [id])?;
    connection.execute("DELETE FROM messages WHERE sender_agent_id = ?", [id])?;
    connection.execute(
        "DELETE FROM conversation_participants WHERE agent_id = ?",
        [id],
    )?;
    connection.execute(
        "UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?",
        [id],
    )?;
    connection.execute(
        "UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?",
        [id],
    )?;
    connection.execute(
        "UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?",
        [id],
    )?;
    connection.execute("DELETE FROM agents WHERE id = ?", [id])?;
    Ok(reply(200, json!({ "success": true })))
}

// ------------------------------------------------- /api/agents/{id}/betaclaw

/// The active runtime session of an agent, if any.
fn active_session(connection: &Connection, agent_id: &str) -> rusqlite::Result<Option<Value>> {
    query_first(
        connection,
        "SELECT * FROM betaclaw_sessions WHERE agent_id = ? AND status = ?",
        params![agent_id, "active"],
    )
}

/// The agent row and whether the caller may see its workspace. `None` answers 404.
fn linkable_agent(
    connection: &Connection,
    access: &Access,
    id: &str,
) -> rusqlite::Result<Option<Value>> {
    let Some(agent) = agent_by_id(connection, id)? else {
        return Ok(None);
    };
    let workspace = text_key(&agent, "workspace_id").unwrap_or("");
    if access.has_workspace(connection, workspace)? {
        Ok(Some(agent))
    } else {
        Ok(None)
    }
}

/// `GET /api/agents/{id}/betaclaw`
pub async fn get_betaclaw(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    get_betaclaw_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to get runtime session", fault))
}

fn get_betaclaw_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    if linkable_agent(&connection, access, id)?.is_none() {
        return Ok(error(404, "Agent not found"));
    }
    Ok(match active_session(&connection, id)? {
        Some(session) => reply(200, json!({ "linked": true, "session": session })),
        None => reply(200, json!({ "linked": false, "session": null })),
    })
}

/// `POST /api/agents/{id}/betaclaw`: links the agent to the runtime.
pub async fn link_betaclaw(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    link_inner(&services, &access, &id)
        .await
        .unwrap_or_else(|fault| internal("Internal server error", fault))
}

async fn link_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let agent = {
        let connection = services.tasks.connection();
        let Some(agent) = linkable_agent(&connection, access, id)? else {
            return Ok(error(404, "Agent not found"));
        };
        if let Some(session) = active_session(&connection, id)? {
            return Ok(reply(
                409,
                json!({ "error": "Agent is already linked to a runtime session", "session": session }),
            ));
        }
        agent
    };
    if services.ensure_connected().await.is_err() {
        return Ok(error(503, "Failed to connect to Mission Control runtime"));
    }
    if let Err(failure) = services.runtime.call("sessions.list", json!({})).await {
        tracing::error!(%failure, "Failed to verify runtime connection");
        return Ok(error(
            503,
            "Connected but failed to communicate with Mission Control runtime",
        ));
    }

    let name = text_key(&agent, "name").unwrap_or("");
    let session_id = new_id();
    let betaclaw_session_id = dispatch_session_id(name);
    let now = now_iso();
    let connection = services.tasks.connection();
    connection.execute(
        "INSERT INTO betaclaw_sessions (id, agent_id, betaclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![session_id, id, betaclaw_session_id, "mission-control", "active", now, now],
    )?;
    connection.execute(
        "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
        params![
            new_id(),
            "agent_status_changed",
            id,
            format!("{name} linked to Mission Control runtime"),
            now
        ],
    )?;
    let session = query_first(
        &connection,
        "SELECT * FROM betaclaw_sessions WHERE id = ?",
        [session_id.as_str()],
    )?
    .unwrap_or(Value::Null);
    Ok(reply(201, json!({ "linked": true, "session": session })))
}

/// `DELETE /api/agents/{id}/betaclaw`: unlinks the agent from the runtime.
pub async fn unlink_betaclaw(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Some(access) = resolve(&state, &headers) else {
        return unauthorized_response();
    };
    unlink_inner(&services, &access, &id)
        .unwrap_or_else(|fault| internal("Failed to unlink agent from runtime", fault))
}

fn unlink_inner(services: &Services, access: &Access, id: &str) -> Outcome {
    let connection = services.tasks.connection();
    let Some(agent) = linkable_agent(&connection, access, id)? else {
        return Ok(error(404, "Agent not found"));
    };
    let Some(session) = active_session(&connection, id)? else {
        return Ok(error(404, "Agent is not linked to a runtime session"));
    };
    let now = now_iso();
    let session_id = text_key(&session, "id").unwrap_or("");
    connection.execute(
        "UPDATE betaclaw_sessions SET status = ?, updated_at = ? WHERE id = ?",
        params!["inactive", now, session_id],
    )?;
    let name = text_key(&agent, "name").unwrap_or("");
    connection.execute(
        "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
        params![
            new_id(),
            "agent_status_changed",
            id,
            format!("{name} unlinked from Mission Control runtime"),
            now
        ],
    )?;
    Ok(reply(200, json!({ "linked": false, "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::families::tasks::ports::{NoSkills, UnwiredRuntime};
    use crate::families::tasks::test_support::{
        fixture, fixture_with, send, FakeRuntime, FixedSkills, Fixture,
    };
    use axum::http::{Method, StatusCode};

    async fn create_agent(fixture: &Fixture, name: &str) -> String {
        let body = json!({ "name": name, "role": "worker" }).to_string();
        let (status, agent) = send(
            fixture,
            Method::POST,
            "/api/agents",
            Some("user-1"),
            Some(&body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        agent["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn agent_is_created_and_its_status_change_is_an_event() {
        let fixture = fixture();
        let id = create_agent(&fixture, "Scout").await;
        assert_eq!(id.len(), 36);

        let (status, body) = send(
            &fixture,
            Method::PATCH,
            &format!("/api/agents/{id}"),
            Some("user-1"),
            Some(r#"{"status":"working","model":"m-1"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "working");
        assert_eq!(body["model"], "m-1");

        let connection = fixture.services.tasks.connection();
        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE agent_id = ? AND type = 'agent_status_changed'",
                [id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
    }

    #[tokio::test]
    async fn delete_removes_the_agent() {
        let fixture = fixture();
        let id = create_agent(&fixture, "Gone").await;
        let (status, body) = send(
            &fixture,
            Method::DELETE,
            &format!("/api/agents/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "success": true }));
        let (status, _) = send(
            &fixture,
            Method::GET,
            &format!("/api/agents/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_clears_the_agents_messages_and_memberships() {
        let fixture = fixture();
        let id = create_agent(&fixture, "Talker").await;
        let other = create_agent(&fixture, "Listener").await;
        {
            let connection = fixture.services.tasks.connection();
            connection
                .execute(
                    "INSERT INTO conversations (id, title, type) VALUES ('room', 'Room', 'group')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO messages (id, conversation_id, sender_agent_id, content)
                     VALUES ('m1', 'room', ?, 'hi')",
                    [id.as_str()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO conversation_participants (conversation_id, agent_id)
                     VALUES ('room', ?), ('room', ?)",
                    [id.as_str(), other.as_str()],
                )
                .unwrap();
        }

        let (status, body) = send(
            &fixture,
            Method::DELETE,
            &format!("/api/agents/{id}"),
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");

        let connection = fixture.services.tasks.connection();
        let count = |sql: &str, agent: &str| -> i64 {
            connection
                .query_row(sql, [agent], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM messages WHERE sender_agent_id = ?",
                &id
            ),
            0
        );
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM conversation_participants WHERE agent_id = ?",
                &id
            ),
            0
        );
        assert_eq!(
            count(
                "SELECT COUNT(*) FROM conversation_participants WHERE agent_id = ?",
                &other
            ),
            1
        );
    }

    #[tokio::test]
    async fn patch_without_fields_is_a_bad_request() {
        let fixture = fixture();
        let id = create_agent(&fixture, "Idle").await;
        let (status, body) = send(
            &fixture,
            Method::PATCH,
            &format!("/api/agents/{id}"),
            Some("user-1"),
            Some("{}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "No updates provided");
    }

    #[tokio::test]
    async fn discover_needs_a_runtime() {
        let fixture = fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |_| {});
        let (status, body) = send(
            &fixture,
            Method::GET,
            "/api/agents/discover",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body["error"],
            "Failed to connect to Mission Control runtime"
        );
    }

    #[tokio::test]
    async fn import_creates_gateway_agents_and_skips_known_ids() {
        let runtime = Arc::new(FakeRuntime::answering(
            "agents.list",
            json!([{"id": "gw-1", "name": "Gateway One", "model": "m"}]),
        ));
        let fixture = fixture_with(runtime, Arc::new(FixedSkills(1)), |_| {});
        let body = r#"{"agents":[{"gateway_agent_id":"gw-1","name":"Gateway One","model":"m"}]}"#;
        let (status, imported) = send(
            &fixture,
            Method::POST,
            "/api/agents/import",
            Some("user-1"),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(imported["imported"].as_array().unwrap().len(), 1);
        assert_eq!(imported["imported"][0]["source"], "gateway");

        let (status, again) = send(
            &fixture,
            Method::POST,
            "/api/agents/import",
            Some("user-1"),
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(again["skipped"][0]["reason"], "Already imported");

        let (status, discovered) = send(
            &fixture,
            Method::GET,
            "/api/agents/discover",
            Some("user-1"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(discovered["total"], 1);
        assert_eq!(discovered["already_imported"], 1);
    }

    #[tokio::test]
    async fn import_rejects_an_entry_without_a_gateway_id() {
        let fixture = fixture();
        let (status, body) = send(
            &fixture,
            Method::POST,
            "/api/agents/import",
            Some("user-1"),
            Some(r#"{"agents":[{"name":"No id"}]}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["error"],
            "Each agent must have gateway_agent_id and name"
        );
    }

    #[tokio::test]
    async fn runtime_link_needs_a_connection_and_unlink_needs_a_link() {
        let fixture = fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |_| {});
        let id = create_agent(&fixture, "Linked").await;
        let uri = format!("/api/agents/{id}/betaclaw");

        let (status, body) = send(&fixture, Method::GET, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "linked": false, "session": null }));

        let (status, _) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

        let (status, body) = send(&fixture, Method::DELETE, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Agent is not linked to a runtime session");
    }

    #[tokio::test]
    async fn runtime_link_creates_a_session_and_unlink_deactivates_it() {
        let fixture = fixture_with(
            Arc::new(FakeRuntime::answering("sessions.list", json!([]))),
            Arc::new(NoSkills),
            |_| {},
        );
        let id = create_agent(&fixture, "Scout Two").await;
        let uri = format!("/api/agents/{id}/betaclaw");

        let (status, body) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["linked"], true);
        assert_eq!(
            body["session"]["betaclaw_session_id"],
            "mission-control-scout-two"
        );

        let (status, _) = send(&fixture, Method::POST, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, body) = send(&fixture, Method::DELETE, &uri, Some("user-1"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "linked": false, "success": true }));
    }

    #[tokio::test]
    async fn an_agent_of_a_foreign_workspace_is_not_found() {
        let fixture = fixture_with(Arc::new(UnwiredRuntime), Arc::new(NoSkills), |config| {
            config.require_auth = true
        });
        {
            let connection = fixture.services.tasks.connection();
            crate::families::tasks::access::grant_workspace_owner(&connection, "default", "user-1")
                .unwrap();
        }
        let id = create_agent(&fixture, "Hidden").await;
        let (status, body) = send(
            &fixture,
            Method::GET,
            &format!("/api/agents/{id}"),
            Some("stranger"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Agent not found");
    }
}
