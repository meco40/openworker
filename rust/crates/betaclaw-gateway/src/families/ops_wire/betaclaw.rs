//! BetaClaw routes: models, sessions, one session, and the runtime status.
//!
//! Port of `app/api/betaclaw/models/route.ts` (GET), `app/api/betaclaw/sessions/route.ts`
//! (GET, POST), `app/api/betaclaw/sessions/[id]/route.ts` (GET, POST, PATCH, DELETE)
//! and `app/api/betaclaw/status/route.ts` (GET). All of them use `withUserContext`
//! and answer 401 without an identity, except `status`, which does the same.
//!
//! The Model Hub pipeline (`p1`) and the provider catalog are real. The Mission
//! Control runtime client, the workspace access and the `betaclaw_sessions` table
//! are ports. A missing port answers as the TypeScript catch block does: 500
//! `Internal server error`, or 503 for a runtime that cannot be reached.

use axum::body::Bytes;
use axum::extract::{Extension, Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::config::LEGACY_LOCAL_USER_ID;
use betaclaw_core::gateway::broadcast::broadcast;
use betaclaw_core::gateway::registry::SharedRegistry;
use betaclaw_core::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
use betaclaw_core::model_hub::provider_catalog::PROVIDER_CATALOG;
use betaclaw_core::model_hub::service::gateway::NoopObserver;
use betaclaw_core::model_hub::service::refresh::NoCodexRefresh;
use betaclaw_core::model_hub::service::{ModelHubService, ServiceDependencies};
use betaclaw_core::model_hub::sqlite::SqliteModelHubRepository;
use betaclaw_core::model_hub::types::PipelineModelEntry;
use betaclaw_core::tasks::repository::TaskRepository;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

use super::ports::{BetaClawPort, PortError, PortFuture};
use super::{now_iso, query_param, require_user, Services};
use crate::families::tasks::wire::{new_id, query_first, query_rows};
use crate::families::tasks::BetaClawRuntime;
use crate::model_hub_transport::ReqwestTransport;
use crate::state::SharedState;

/// Production implementation of [`BetaClawPort`] over `mission-control.db` (`TaskRepository`)
/// and the integrated [`BetaClawRuntime`].
pub struct CoreBetaClaw {
    tasks: Arc<TaskRepository>,
    runtime: Arc<dyn BetaClawRuntime>,
    registry: SharedRegistry,
    require_auth: bool,
}

impl CoreBetaClaw {
    pub fn new(
        tasks: Arc<TaskRepository>,
        runtime: Arc<dyn BetaClawRuntime>,
        registry: SharedRegistry,
        require_auth: bool,
    ) -> Self {
        Self {
            tasks,
            runtime,
            registry,
            require_auth,
        }
    }

    fn sees_every_workspace(&self, user_id: &str) -> bool {
        !self.require_auth && user_id == LEGACY_LOCAL_USER_ID
    }
}

impl Services {
    /// Replaces the BetaClaw port with [`CoreBetaClaw`].
    pub fn with_betaclaw(
        mut self,
        tasks: Arc<TaskRepository>,
        runtime: Arc<dyn BetaClawRuntime>,
        registry: SharedRegistry,
        require_auth: bool,
    ) -> Self {
        self.betaclaw = Arc::new(CoreBetaClaw::new(tasks, runtime, registry, require_auth));
        self
    }
}

fn db_failed(error: impl std::fmt::Display) -> PortError {
    PortError::Failed(error.to_string())
}

impl BetaClawPort for CoreBetaClaw {
    fn runtime_connected(&self) -> bool {
        self.runtime.is_connected()
    }

    fn runtime_connect(&self) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.runtime
                .connect()
                .await
                .map_err(|error| PortError::Failed(error.0))
        })
    }

    fn runtime_endpoint(&self) -> Result<(String, String), PortError> {
        Ok((
            "integrated://betaclaw".to_string(),
            "integrated".to_string(),
        ))
    }

    fn runtime_list_sessions(&self) -> PortFuture<'_, Vec<Value>> {
        Box::pin(async move {
            let value = self
                .runtime
                .call("sessions.list", json!({}))
                .await
                .map_err(|error| PortError::Failed(error.0))?;
            Ok(value.as_array().cloned().unwrap_or_default())
        })
    }

    fn runtime_create_session(
        &self,
        channel: String,
        peer: Value,
        workspace_id: String,
    ) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let row_id = new_id();
            let session_id = format!("agent:main:mission-control-{row_id}");
            let peer_text = match &peer {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                other => Some(other.to_string()),
            };
            let connection = self.tasks.connection();
            connection
                .execute(
                    "INSERT INTO betaclaw_sessions (id, betaclaw_session_id, channel, peer, session_type, status, workspace_id)
                     VALUES (?1, ?2, ?3, ?4, 'persistent', 'active', ?5)",
                    params![row_id, session_id, channel, peer_text, workspace_id],
                )
                .map_err(db_failed)?;
            Ok(json!({
                "id": session_id,
                "channel": channel,
                "peer": peer,
                "status": "active",
            }))
        })
    }

    fn runtime_send_message(&self, session_id: String, content: String) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.runtime
                .call(
                    "chat.send",
                    json!({ "sessionKey": session_id, "message": content }),
                )
                .await
                .map(|_| ())
                .map_err(|error| PortError::Failed(error.0))
        })
    }

    fn accessible_workspace_ids(&self, user_id: String) -> PortFuture<'_, Vec<String>> {
        Box::pin(async move {
            let connection = self.tasks.connection();
            if self.sees_every_workspace(&user_id) {
                let mut stmt = connection
                    .prepare("SELECT id FROM workspaces ORDER BY name")
                    .map_err(db_failed)?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(db_failed)?
                    .collect::<rusqlite::Result<Vec<String>>>()
                    .map_err(db_failed)?;
                Ok(rows)
            } else {
                let mut stmt = connection
                    .prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ?1 ORDER BY workspace_id")
                    .map_err(db_failed)?;
                let rows = stmt
                    .query_map([&user_id], |row| row.get::<_, String>(0))
                    .map_err(db_failed)?
                    .collect::<rusqlite::Result<Vec<String>>>()
                    .map_err(db_failed)?;
                Ok(rows)
            }
        })
    }

    fn has_workspace_access(&self, user_id: String, workspace_id: String) -> PortFuture<'_, bool> {
        Box::pin(async move {
            let trimmed = workspace_id.trim();
            if trimmed.is_empty() || trimmed.len() > 200 {
                return Ok(false);
            }
            let connection = self.tasks.connection();
            let exists = connection
                .query_row("SELECT 1 FROM workspaces WHERE id = ?1", [trimmed], |_| {
                    Ok(())
                })
                .optional()
                .map_err(db_failed)?
                .is_some();
            if !exists {
                return Ok(false);
            }
            if self.sees_every_workspace(&user_id) {
                return Ok(true);
            }
            let member = connection
                .query_row(
                    "SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
                    params![trimmed, user_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(db_failed)?
                .is_some();
            Ok(member)
        })
    }

    fn can_access_session(&self, user_id: String, session_id: String) -> PortFuture<'_, bool> {
        Box::pin(async move {
            let workspace_id: Option<String> = {
                let connection = self.tasks.connection();
                connection
                    .query_row(
                        "SELECT COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) AS workspace_id
                         FROM betaclaw_sessions s
                         LEFT JOIN agents a ON a.id = s.agent_id
                         LEFT JOIN tasks t ON t.id = s.task_id
                         WHERE s.betaclaw_session_id = ?1 OR s.id = ?1
                         LIMIT 1",
                        [&session_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(db_failed)?
                    .flatten()
            };
            let Some(workspace_id) = workspace_id else {
                return Ok(false);
            };
            self.has_workspace_access(user_id, workspace_id).await
        })
    }

    fn accessible_session_count(&self, user_id: String) -> PortFuture<'_, usize> {
        Box::pin(async move {
            let ids = self.accessible_workspace_ids(user_id).await?;
            if ids.is_empty() {
                return Ok(0);
            }
            let placeholders = (1..=ids.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT COUNT(*) FROM betaclaw_sessions WHERE workspace_id IN ({placeholders})"
            );
            let connection = self.tasks.connection();
            let count: i64 = connection
                .query_row(&sql, rusqlite::params_from_iter(ids.iter()), |row| {
                    row.get(0)
                })
                .map_err(db_failed)?;
            Ok(count.max(0) as usize)
        })
    }

    fn db_sessions(
        &self,
        workspace_ids: Vec<String>,
        session_type: Option<String>,
        status: Option<String>,
    ) -> PortFuture<'_, Vec<Value>> {
        Box::pin(async move {
            if workspace_ids.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = vec!["?"; workspace_ids.len()].join(", ");
            let mut sql = format!(
                "SELECT s.*
                 FROM betaclaw_sessions s
                 LEFT JOIN agents a ON a.id = s.agent_id
                 LEFT JOIN tasks t ON t.id = s.task_id
                 WHERE COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) IN ({placeholders})"
            );
            let mut params = workspace_ids;
            if let Some(st) = session_type {
                sql.push_str(" AND session_type = ?");
                params.push(st);
            }
            if let Some(st) = status {
                sql.push_str(" AND status = ?");
                params.push(st);
            }
            sql.push_str(" ORDER BY created_at DESC");
            let connection = self.tasks.connection();
            query_rows(&connection, &sql, rusqlite::params_from_iter(params.iter()))
                .map_err(db_failed)
        })
    }

    fn db_runtime_session_ids(&self, workspace_ids: Vec<String>) -> PortFuture<'_, Vec<String>> {
        Box::pin(async move {
            if workspace_ids.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = vec!["?"; workspace_ids.len()].join(", ");
            let sql = format!(
                "SELECT s.betaclaw_session_id
                 FROM betaclaw_sessions s
                 LEFT JOIN agents a ON a.id = s.agent_id
                 LEFT JOIN tasks t ON t.id = s.task_id
                 WHERE COALESCE(s.workspace_id, a.workspace_id, t.workspace_id) IN ({placeholders})"
            );
            let connection = self.tasks.connection();
            let mut stmt = connection.prepare(&sql).map_err(db_failed)?;
            let ids = stmt
                .query_map(rusqlite::params_from_iter(workspace_ids.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(db_failed)?
                .collect::<rusqlite::Result<Vec<String>>>()
                .map_err(db_failed)?;
            Ok(ids)
        })
    }

    fn db_find_runtime_session(&self, session_id: String) -> PortFuture<'_, Option<Value>> {
        Box::pin(async move {
            let connection = self.tasks.connection();
            query_first(
                &connection,
                "SELECT * FROM betaclaw_sessions WHERE betaclaw_session_id = ?1",
                [&session_id],
            )
            .map_err(db_failed)
        })
    }

    fn db_find_session(&self, session_id: String) -> PortFuture<'_, Option<Value>> {
        Box::pin(async move {
            let connection = self.tasks.connection();
            if let Some(row) = query_first(
                &connection,
                "SELECT * FROM betaclaw_sessions WHERE betaclaw_session_id = ?1",
                [&session_id],
            )
            .map_err(db_failed)?
            {
                return Ok(Some(row));
            }
            query_first(
                &connection,
                "SELECT * FROM betaclaw_sessions WHERE id = ?1",
                [&session_id],
            )
            .map_err(db_failed)
        })
    }

    fn db_patch_session(
        &self,
        row: Value,
        status: Option<Value>,
        ended_at: Option<Value>,
    ) -> PortFuture<'_, Value> {
        Box::pin(async move {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let session_id = row
                .get("betaclaw_session_id")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let agent_id = row
                .get("agent_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let task_id = row
                .get("task_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let updated_at = now_iso();
            let updated = {
                let connection = self.tasks.connection();
                if let Some(ref st) = status {
                    connection
                        .execute(
                            "UPDATE betaclaw_sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
                            params![st.as_str(), updated_at, id],
                        )
                        .map_err(db_failed)?;
                }
                if let Some(ref ended) = ended_at {
                    connection
                        .execute(
                            "UPDATE betaclaw_sessions SET ended_at = ?1, updated_at = ?2 WHERE id = ?3",
                            params![ended.as_str(), updated_at, id],
                        )
                        .map_err(db_failed)?;
                }
                if status.as_ref().and_then(Value::as_str) == Some("completed") {
                    if let Some(ref aid) = agent_id {
                        let _ = connection
                            .execute("UPDATE agents SET status = 'idle' WHERE id = ?1", [aid]);
                    }
                }
                query_first(
                    &connection,
                    "SELECT * FROM betaclaw_sessions WHERE id = ?1",
                    [&id],
                )
                .map_err(db_failed)?
                .unwrap_or(Value::Null)
            };
            if status.as_ref().and_then(Value::as_str) == Some("completed") {
                if let Some(tid) = task_id {
                    broadcast(
                        &self.registry,
                        "agent_completed",
                        Some(json!({ "taskId": tid, "sessionId": session_id })),
                    );
                }
            }
            Ok(updated)
        })
    }

    fn db_delete_session(&self, row: Value) -> PortFuture<'_, ()> {
        Box::pin(async move {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let session_id = row
                .get("betaclaw_session_id")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let agent_id = row
                .get("agent_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let task_id = row
                .get("task_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            {
                let connection = self.tasks.connection();
                connection
                    .execute("DELETE FROM betaclaw_sessions WHERE id = ?1", [&id])
                    .map_err(db_failed)?;
                if let Some(ref aid) = agent_id {
                    let role: Option<String> = connection
                        .query_row("SELECT role FROM agents WHERE id = ?1", [aid], |r| r.get(0))
                        .optional()
                        .map_err(db_failed)?;
                    if role.as_deref() == Some("Sub-Agent") {
                        let _ = connection.execute("DELETE FROM agents WHERE id = ?1", [aid]);
                    } else if role.is_some() {
                        let _ = connection
                            .execute("UPDATE agents SET status = 'idle' WHERE id = ?1", [aid]);
                    }
                }
            }
            if let Some(tid) = task_id {
                broadcast(
                    &self.registry,
                    "agent_completed",
                    Some(json!({
                        "taskId": tid,
                        "sessionId": session_id,
                        "deleted": true,
                    })),
                );
            }
            Ok(())
        })
    }
}

pub(super) fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/betaclaw/models", get(models))
        .route(
            "/api/betaclaw/sessions",
            get(sessions_list).post(sessions_create),
        )
        .route(
            "/api/betaclaw/sessions/{id}",
            get(session_get)
                .post(session_message)
                .patch(session_patch)
                .delete(session_delete),
        )
        .route("/api/betaclaw/status", get(status))
}

/// The 500 body of the TypeScript `catch` blocks.
fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Internal server error" })),
    )
        .into_response()
}

/// A `{ error }` body with the given status.
fn error_body(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// JavaScript truthiness of a JSON value, as the `if (!x)` checks read it.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value)` for the fields that are coerced to text.
fn as_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `normalizeWorkspaceId`: a trimmed, non-empty string, or `None`.
fn normalize_workspace_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

/// Parses a JSON request body. A parse failure is the `catch` path, a 500.
#[allow(clippy::result_large_err)]
fn parse_body(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body).map_err(|_| internal_error())
}

/// `listPipeline(profileId)` through the Model Hub service.
fn pipeline_entries(
    state: &SharedState,
    services: &Services,
    profile_id: &str,
) -> Result<Vec<PipelineModelEntry>, String> {
    let repository = SqliteModelHubRepository::open(&services.model_hub_db_path)
        .map_err(|error| error.to_string())?;
    let transport = ReqwestTransport::with_client(state.upstream.clone());
    let service = ModelHubService::new(
        &repository,
        ServiceDependencies {
            transport: &transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            observer: &NoopObserver,
            env: &services.env,
            codex: &NoCodexRefresh,
        },
    );
    service
        .list_pipeline(profile_id)
        .map_err(|error| error.to_string())
}

/// `buildFallbackModelInfo`: every default model of the provider catalog.
fn fallback_model_info() -> Value {
    let mut models: Vec<String> = PROVIDER_CATALOG
        .iter()
        .flat_map(|provider| provider.default_models.iter())
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect();
    models.sort();
    models.dedup();
    model_info(&models)
}

/// The `{ defaultModel?, availableModels }` shape. `defaultModel` is omitted when empty.
fn model_info(models: &[String]) -> Value {
    let mut info = json!({ "availableModels": models });
    if let (Some(first), Some(object)) = (models.first(), info.as_object_mut()) {
        object.insert("defaultModel".to_string(), Value::String(first.clone()));
    }
    info
}

/// `buildIntegratedModelInfo`: the `p1` pipeline, active entries first.
fn integrated_model_info(state: &SharedState, services: &Services) -> Result<Value, String> {
    let mut pipeline = pipeline_entries(state, services, "p1")?;
    if pipeline.is_empty() {
        return Ok(fallback_model_info());
    }
    pipeline.sort_by_key(|entry| entry.priority);
    let active: Vec<&PipelineModelEntry> = pipeline
        .iter()
        .filter(|entry| entry.status == betaclaw_core::model_hub::types::PipelineStatus::Active)
        .collect();
    let ordered: Vec<&PipelineModelEntry> = if active.is_empty() {
        pipeline.iter().collect()
    } else {
        active
    };
    let mut models: Vec<String> = Vec::new();
    for entry in ordered {
        let name = entry.model_name.trim().to_string();
        if !name.is_empty() && !models.contains(&name) {
            models.push(name);
        }
    }
    Ok(model_info(&models))
}

/// `GET /api/betaclaw/models`. A failure answers 200 with the fallback list and an
/// `error` field, as the route does.
async fn models(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_user(&headers) {
        return response;
    }
    match integrated_model_info(&state, &services) {
        Ok(info) => Json(info).into_response(),
        Err(message) => {
            let mut info = fallback_model_info();
            if let Some(object) = info.as_object_mut() {
                object.insert("error".to_string(), Value::String(message));
            }
            Json(info).into_response()
        }
    }
}

/// Connects the runtime client when it is down. A failure is the 503 of the route.
#[allow(clippy::result_large_err)]
async fn ensure_runtime(services: &Services) -> Result<(), Response> {
    if services.betaclaw.runtime_connected() {
        return Ok(());
    }
    services.betaclaw.runtime_connect().await.map_err(|_| {
        error_body(
            StatusCode::SERVICE_UNAVAILABLE,
            "Failed to connect to Mission Control runtime",
        )
    })
}

/// `GET /api/betaclaw/sessions`: with `session_type` or `status`, the table rows; without,
/// the live runtime sessions the caller can access.
async fn sessions_list(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let session_type = query_param(&uri, "session_type").filter(|value| !value.is_empty());
    let status = query_param(&uri, "status").filter(|value| !value.is_empty());
    let betaclaw = &services.betaclaw;

    if session_type.is_some() || status.is_some() {
        let workspace_ids = match betaclaw.accessible_workspace_ids(user_id).await {
            Ok(ids) => ids,
            Err(_) => return internal_error(),
        };
        if workspace_ids.is_empty() {
            return Json(json!([])).into_response();
        }
        return match betaclaw
            .db_sessions(workspace_ids, session_type, status)
            .await
        {
            Ok(rows) => Json(Value::Array(rows)).into_response(),
            Err(_) => internal_error(),
        };
    }

    if let Err(response) = ensure_runtime(&services).await {
        return response;
    }
    let workspace_ids = match betaclaw.accessible_workspace_ids(user_id).await {
        Ok(ids) => ids,
        Err(_) => return internal_error(),
    };
    if workspace_ids.is_empty() {
        return Json(json!({ "sessions": [] })).into_response();
    }
    let accessible: HashSet<String> = match betaclaw.db_runtime_session_ids(workspace_ids).await {
        Ok(ids) => ids.into_iter().collect(),
        Err(_) => return internal_error(),
    };
    match betaclaw.runtime_list_sessions().await {
        Ok(sessions) => {
            let visible: Vec<Value> = sessions
                .into_iter()
                .filter(|session| {
                    session
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| accessible.contains(id))
                })
                .collect();
            Json(json!({ "sessions": visible })).into_response()
        }
        Err(_) => internal_error(),
    }
}

/// `POST /api/betaclaw/sessions`: starts a runtime session in an accessible workspace.
async fn sessions_create(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let channel = body.get("channel").cloned().unwrap_or(Value::Null);
    if !truthy(&channel) {
        return error_body(StatusCode::BAD_REQUEST, "channel is required");
    }
    let peer = body.get("peer").cloned().unwrap_or(Value::Null);
    let Some(workspace_id) = normalize_workspace_id(body.get("workspace_id")) else {
        return error_body(StatusCode::BAD_REQUEST, "workspace_id is required");
    };
    match services
        .betaclaw
        .has_workspace_access(user_id, workspace_id.clone())
        .await
    {
        Ok(true) => {}
        Ok(false) => return error_body(StatusCode::BAD_REQUEST, "workspace_id is required"),
        Err(_) => return internal_error(),
    }

    if let Err(response) = ensure_runtime(&services).await {
        return response;
    }
    match services
        .betaclaw
        .runtime_create_session(as_text(&channel), peer, workspace_id)
        .await
    {
        Ok(session) => (StatusCode::CREATED, Json(json!({ "session": session }))).into_response(),
        Err(_) => internal_error(),
    }
}

/// `canAccessSession(userContext, id)`, with a port failure as the 500 of the route.
#[allow(clippy::result_large_err)]
async fn may_access(
    services: &Services,
    user_id: String,
    session_id: String,
) -> Result<bool, Response> {
    services
        .betaclaw
        .can_access_session(user_id, session_id)
        .await
        .map_err(|_| internal_error())
}

/// `GET /api/betaclaw/sessions/{id}`
async fn session_get(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    match may_access(&services, user_id, id.clone()).await {
        Ok(true) => {}
        Ok(false) => return error_body(StatusCode::NOT_FOUND, "Session not found"),
        Err(response) => return response,
    }
    if let Err(response) = ensure_runtime(&services).await {
        return response;
    }
    match services.betaclaw.runtime_list_sessions().await {
        Ok(sessions) => {
            match sessions
                .into_iter()
                .find(|session| session.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                Some(session) => Json(json!({ "session": session })).into_response(),
                None => error_body(StatusCode::NOT_FOUND, "Session not found"),
            }
        }
        Err(_) => internal_error(),
    }
}

/// `POST /api/betaclaw/sessions/{id}`: sends one message, prefixed with the source.
async fn session_message(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    match may_access(&services, user_id, id.clone()).await {
        Ok(true) => {}
        Ok(false) => return error_body(StatusCode::NOT_FOUND, "Session not found"),
        Err(response) => return response,
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let content = body.get("content").cloned().unwrap_or(Value::Null);
    if !truthy(&content) {
        return error_body(StatusCode::BAD_REQUEST, "content is required");
    }
    if let Err(response) = ensure_runtime(&services).await {
        return response;
    }
    match services
        .betaclaw
        .runtime_send_message(id, format!("[Mission Control] {}", as_text(&content)))
        .await
    {
        Ok(()) => Json(json!({ "success": true })).into_response(),
        Err(_) => internal_error(),
    }
}

/// `PATCH /api/betaclaw/sessions/{id}`: updates the row of a session.
async fn session_patch(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    match may_access(&services, user_id, id.clone()).await {
        Ok(true) => {}
        Ok(false) => return error_body(StatusCode::NOT_FOUND, "Session not found"),
        Err(response) => return response,
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let row = match services.betaclaw.db_find_runtime_session(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error_body(StatusCode::NOT_FOUND, "Session not found in database"),
        Err(_) => return internal_error(),
    };
    // `undefined` is an absent key; an explicit `null` still counts as an update.
    let status = body.get("status").cloned();
    let ended_at = body.get("ended_at").cloned();
    if status.is_none() && ended_at.is_none() {
        return error_body(StatusCode::BAD_REQUEST, "No updates provided");
    }
    match services
        .betaclaw
        .db_patch_session(row, status, ended_at)
        .await
    {
        Ok(updated) => Json(updated).into_response(),
        Err(_) => internal_error(),
    }
}

/// `DELETE /api/betaclaw/sessions/{id}`: removes the session row and its sub-agent.
async fn session_delete(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    match may_access(&services, user_id, id.clone()).await {
        Ok(true) => {}
        Ok(false) => return error_body(StatusCode::NOT_FOUND, "Session not found"),
        Err(response) => return response,
    }
    let row = match services.betaclaw.db_find_session(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return error_body(StatusCode::NOT_FOUND, "Session not found"),
        Err(_) => return internal_error(),
    };
    let deleted = row.get("id").cloned().unwrap_or(Value::Null);
    match services.betaclaw.db_delete_session(row).await {
        Ok(()) => Json(json!({ "success": true, "deleted": deleted })).into_response(),
        Err(_) => internal_error(),
    }
}

/// `GET /api/betaclaw/status`: the runtime connection and the caller's session count.
async fn status(Extension(services): Extension<Arc<Services>>, headers: HeaderMap) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let (gateway_url, mode) = match services.betaclaw.runtime_endpoint() {
        Ok((url, mode)) => (Value::String(url), Value::String(mode)),
        Err(_) => (Value::Null, Value::Null),
    };

    if !services.betaclaw.runtime_connected() && services.betaclaw.runtime_connect().await.is_err()
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "connected": false,
                "error": "Failed to initialize Mission Control runtime",
                "runtime_url": gateway_url,
                "gateway_url": gateway_url,
                "mode": mode,
            })),
        )
            .into_response();
    }

    // A failed count is 0, as the route catches it and logs a warning.
    let sessions_count = services
        .betaclaw
        .accessible_session_count(user_id)
        .await
        .unwrap_or(0);
    Json(json!({
        "connected": true,
        "sessions_count": sessions_count,
        "runtime_url": gateway_url,
        "gateway_url": gateway_url,
        "mode": mode,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use crate::families::ops_wire::test_support::{
        fake_betaclaw_services, fake_services, scratch, send, state_in,
    };

    #[tokio::test]
    async fn models_without_user_is_unauthorized() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/models",
            &[],
            None,
        )
        .await;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            serde_json::json!({ "ok": false, "error": "Unauthorized" })
        );
    }

    #[tokio::test]
    async fn models_with_an_empty_pipeline_fall_back_to_the_catalog() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/models",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 200);
        let models = body["availableModels"].as_array().expect("array");
        assert!(!models.is_empty());
        assert_eq!(body["defaultModel"], models[0]);
        assert!(body.get("error").is_none());
    }

    #[tokio::test]
    async fn session_list_without_a_runtime_is_503() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/sessions",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(
            body,
            serde_json::json!({ "error": "Failed to connect to Mission Control runtime" })
        );
    }

    #[tokio::test]
    async fn session_table_query_without_a_port_is_500() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/sessions?status=running",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 500);
        assert_eq!(
            body,
            serde_json::json!({ "error": "Internal server error" })
        );
    }

    #[tokio::test]
    async fn create_session_checks_channel_then_workspace() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/betaclaw/sessions",
            &headers,
            Some(r#"{"peer":"x"}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(body, serde_json::json!({ "error": "channel is required" }));

        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/betaclaw/sessions",
            &headers,
            Some(r#"{"channel":"webchat","workspace_id":"  "}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(
            body,
            serde_json::json!({ "error": "workspace_id is required" })
        );
    }

    #[tokio::test]
    async fn session_routes_return_not_found_for_an_inaccessible_session() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_betaclaw_services(&scratch, false);
        let headers = [("x-betaclaw-user-id", "user-a")];
        for method in [Method::GET, Method::DELETE] {
            let (status, body) = send(
                &state,
                &services,
                method,
                "/api/betaclaw/sessions/s-1",
                &headers,
                None,
            )
            .await;
            assert_eq!(status, 404);
            assert_eq!(body, serde_json::json!({ "error": "Session not found" }));
        }
    }

    #[tokio::test]
    async fn session_message_requires_content() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_betaclaw_services(&scratch, true);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/betaclaw/sessions/s-1",
            &headers,
            Some(r#"{}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(body, serde_json::json!({ "error": "content is required" }));
    }

    #[tokio::test]
    async fn patch_of_an_unknown_row_is_404_before_the_update_check() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_betaclaw_services(&scratch, true);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::PATCH,
            "/api/betaclaw/sessions/s-1",
            &headers,
            Some(r#"{}"#),
        )
        .await;
        assert_eq!(status, 404);
        assert_eq!(
            body,
            serde_json::json!({ "error": "Session not found in database" })
        );
    }

    #[tokio::test]
    async fn status_reports_a_runtime_that_will_not_connect() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_betaclaw_services(&scratch, true);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/status",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 503);
        assert_eq!(body["connected"], false);
        assert_eq!(
            body["error"],
            "Failed to initialize Mission Control runtime"
        );
        assert_eq!(body["runtime_url"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn status_without_user_is_unauthorized() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/betaclaw/status",
            &[],
            None,
        )
        .await;
        assert_eq!(status, 401);
        assert_eq!(body["error"], "Unauthorized");
    }
}
