//! Memory API routes.
//!
//! Port of `app/api/memory/route.ts` (GET, POST, PUT, DELETE, PATCH) and the
//! five handlers of `src/server/memory/api/**` (`getHandler.ts`, `postHandler.ts`,
//! `putHandler.ts`, `deleteHandler.ts`, `patchHandler.ts`, plus the parsing and
//! scope helpers of `shared.ts`).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `app/api/memory/route.ts:8-22`                | [`router`] |
//! | `api/getHandler.ts:15-110`                    | [`handle_get`] |
//! | `api/postHandler.ts:11-56`                    | [`handle_post`] |
//! | `api/putHandler.ts:11-56`                     | [`handle_put`] |
//! | `api/deleteHandler.ts:13-46`                  | [`handle_delete`] |
//! | `api/patchHandler.ts:10-44`                   | [`handle_patch`] |
//! | `api/shared.ts:8-249`                         | the parsing helpers below |
//!
//! The route is mounted from `routes/mod.rs` and runs against the ported memory
//! service/runtime (`betaclaw_core::memory::{runtime, service}`).
//!
//! # Wiring notes
//!
//! 1. **Provider selection.** [`MemoryContext::build`] resolves the client
//!    through [`MemoryRuntime::from_env`]. The gateway supplies a
//!    [`MemoryClientFactory`] that builds the SQLite client, the env Mem0 client
//!    (over the gateway's [`ReqwestTransport`]) or the canonical PostgreSQL
//!    client over the lazy shared S6 pool.
//! 2. **The message repository.** `resolveMemoryReadUserScopes` reads the
//!    conversations of the legacy local user through `AppState::messages`, the
//!    same store the message routes use.
//! 3. **`console.warn`** becomes `tracing::warn!`; the texts are unchanged.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use betaclaw_core::memory::lifecycle::MemoryLifecycleBus;
use betaclaw_core::memory::mem0::create_mem0_client_from_env;
use betaclaw_core::memory::postgres::PostgresMemoryClient;
use betaclaw_core::memory::runtime::{
    assert_memory_runtime_configuration, configured_provider, ConfiguredProvider,
    MemoryClientFactory, MemoryRuntime, MemoryRuntimeError,
};
use betaclaw_core::memory::service::{
    BulkUpdatePatch, Mem0PolicyConfig, MemoryPageRequest, MemoryRestoreInput, MemoryService,
    MemoryServiceDependencies, MemoryStoreInput, MemoryUpdateInput,
};
use betaclaw_core::memory::sqlite::client::SqliteMemoryClient;
use betaclaw_core::memory::types::{
    js_number, Mem0Client, MemoryMetadata, MemoryType, LEGACY_LOCAL_USER_ID,
};
use betaclaw_core::messages_store::types::Conversation;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::resolve_world_model_config;
use betaclaw_core::world_model::db::PgExecutor;

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::model_hub_transport::ReqwestTransport;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

// `ALLOWED_TYPES` (`shared.ts:11-18`) is `MemoryType::ALL`
// (`betaclaw_core::memory::types`), which already carries the six spellings in
// declaration order, so the validator does not restate the list.

/// `DELETE_ALL_CONFIRM_TOKEN` — `shared.ts:20`.
const DELETE_ALL_CONFIRM_TOKEN: &str = "delete-all-memory";

/// `MEMORY_RUNTIME_UNAVAILABLE_MESSAGE` — `shared.ts:21-22`.
const MEMORY_RUNTIME_UNAVAILABLE_MESSAGE: &str =
    "Memory runtime unavailable: the configured provider is not ready.";

/// The failure shapes the five handlers translate into status codes.
#[derive(Debug)]
enum ApiError {
    /// `ValidationError` — `shared.ts:8`.
    Validation(String),
    /// `MemoryRuntimeUnavailableError` — `shared.ts:9`.
    Unavailable,
    /// `MemoryVersionConflictError` — `putHandler.ts:52`.
    Conflict(String),
    /// Every other thrown error.
    Internal(String),
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::Validation(_) => StatusCode::BAD_REQUEST,
            ApiError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn message(&self) -> String {
        match self {
            ApiError::Validation(message)
            | ApiError::Conflict(message)
            | ApiError::Internal(message) => message.clone(),
            ApiError::Unavailable => MEMORY_RUNTIME_UNAVAILABLE_MESSAGE.to_string(),
        }
    }
}

fn error_response(error: ApiError) -> Response {
    (
        error.status(),
        Json(json!({ "ok": false, "error": error.message() })),
    )
        .into_response()
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn map_runtime_error(error: MemoryRuntimeError) -> ApiError {
    match error {
        MemoryRuntimeError::Unavailable(_) => ApiError::Unavailable,
        MemoryRuntimeError::Configuration(message) => ApiError::Internal(message),
    }
}

/// `error instanceof MemoryVersionConflictError` — `putHandler.ts:48-53`.
fn map_memory_error(error: betaclaw_core::memory::errors::MemoryError) -> ApiError {
    if error.version_conflict().is_some() {
        ApiError::Conflict(error.to_string())
    } else {
        ApiError::Internal(error.to_string())
    }
}

/// `getRequiredMemoryClient`'s error text — `runtime.ts:136-139`.
const CLIENT_UNAVAILABLE_MESSAGE: &str = "Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite.";

/// The client constructor seam of the gateway (`runtime.ts:112-124`).
struct GatewayMemoryClientFactory {
    transport: Arc<dyn HttpTransport>,
    postgres_executor: Option<Arc<dyn PgExecutor>>,
}

impl MemoryClientFactory for GatewayMemoryClientFactory {
    fn create(
        &self,
        provider: ConfiguredProvider,
        env: &HashMap<String, String>,
    ) -> Result<Box<dyn Mem0Client>, MemoryRuntimeError> {
        match provider {
            ConfiguredProvider::Sqlite => SqliteMemoryClient::new()
                .map(|client| Box::new(client) as Box<dyn Mem0Client>)
                .map_err(|error| MemoryRuntimeError::Configuration(error.to_string())),
            ConfiguredProvider::Mem0 => match create_mem0_client_from_env(env, self.transport.clone())
            {
                Ok(Some(client)) => Ok(Box::new(client) as Box<dyn Mem0Client>),
                Ok(None) => Err(MemoryRuntimeError::Configuration(
                    CLIENT_UNAVAILABLE_MESSAGE.to_string(),
                )),
                Err(error) => Err(MemoryRuntimeError::Configuration(error.to_string())),
            },
            ConfiguredProvider::Postgres => self
                .postgres_executor
                .as_ref()
                .map(|executor| {
                    Box::new(PostgresMemoryClient::new(Arc::clone(executor)))
                        as Box<dyn Mem0Client>
                })
                .ok_or_else(|| {
                    MemoryRuntimeError::Configuration(
                        "Invalid memory configuration: the canonical PostgreSQL executor is unavailable."
                            .to_string(),
                    )
                }),
        }
    }
}

/// The runtime and the World-Model policy of one request.
struct MemoryContext {
    runtime: MemoryRuntime,
    policy: Mem0PolicyConfig,
    lifecycle_bus: MemoryLifecycleBus,
}

impl MemoryContext {
    async fn build(state: &SharedState) -> Result<Self, ApiError> {
        let env: HashMap<String, String> = std::env::vars().collect();
        assert_memory_runtime_configuration(&env).map_err(map_runtime_error)?;
        let world_model = resolve_world_model_config(&env);
        let postgres_executor = if configured_provider(&env) == ConfiguredProvider::Postgres {
            Some(
                state
                    .get_world_model_pg_executor(&world_model)
                    .await
                    .map_err(|error| ApiError::Internal(error.to_string()))?,
            )
        } else {
            None
        };
        let transport: Arc<dyn HttpTransport> =
            Arc::new(ReqwestTransport::with_client(state.upstream.clone()));
        let runtime = MemoryRuntime::from_env(
            &env,
            &GatewayMemoryClientFactory {
                transport,
                postgres_executor,
            },
        )
        .map_err(map_runtime_error)?;
        let policy = Mem0PolicyConfig {
            mem0_preferences_only: world_model.mem0_preferences_only,
            mode_canonical: world_model.mode.is_canonical(),
        };
        Ok(Self {
            runtime,
            policy,
            lifecycle_bus: state.memory_lifecycle_bus.clone(),
        })
    }

    fn dependencies(&self) -> MemoryServiceDependencies<'_> {
        MemoryServiceDependencies {
            publisher: &self.lifecycle_bus,
            policy: &self.policy,
            counter: None,
        }
    }
}

/// `getReadyMemoryService` — `shared.ts:24-36`.
///
/// `Ok(None)` is the TypeScript `null` (the runtime is degraded); the caller
/// decides between the degraded GET answers and the 503 of the other verbs.
fn ready_service<'a>(context: &'a MemoryContext) -> Result<MemoryService<'a>, ApiError> {
    match context
        .runtime
        .memory_service_if_ready(context.dependencies())
    {
        Ok(Some(service)) => Ok(service),
        Ok(None) => Err(ApiError::Unavailable),
        Err(error) => Err(map_runtime_error(error)),
    }
}

/// A default empty metadata bag (`Record<string, unknown>` with no entries).
fn empty_metadata() -> MemoryMetadata {
    Map::new()
}

/// `String(raw || '')` — the coercion every parser of `shared.ts` starts with.
fn js_or_empty(raw: Option<&Value>) -> String {
    match raw {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(number))
            if number
                .as_f64()
                .is_some_and(|value| value == 0.0 || value.is_nan()) =>
        {
            String::new()
        }
        Some(Value::String(text)) if text.is_empty() => String::new(),
        other => betaclaw_core::memory::types::js_string(other),
    }
}

/// `parsePersonaId` — `shared.ts:82-88`.
fn parse_persona_id(raw: Option<&Value>) -> Result<String, ApiError> {
    let persona_id = js_or_empty(raw).trim().to_string();
    if persona_id.is_empty() {
        return Err(ApiError::Validation("personaId is required.".to_string()));
    }
    Ok(persona_id)
}

/// `parseMemoryNodeId` — `shared.ts:90-96`.
fn parse_memory_node_id(raw: Option<&Value>) -> Result<String, ApiError> {
    let node_id = js_or_empty(raw).trim().to_string();
    if node_id.is_empty() {
        return Err(ApiError::Validation("id is required.".to_string()));
    }
    Ok(node_id)
}

/// `parseOptionalWorkspaceId` — `shared.ts:69-80`.
fn parse_optional_workspace_id(raw: Option<&Value>) -> Result<Option<String>, ApiError> {
    let workspace_id = js_or_empty(raw).trim().to_string();
    if workspace_id.is_empty() {
        return Ok(None);
    }
    let contains_control_character = workspace_id
        .chars()
        .any(|character| (character as u32) <= 0x1f || (character as u32) == 0x7f);
    if workspace_id.encode_utf16().count() > 255 || contains_control_character {
        return Err(ApiError::Validation("workspaceId is invalid.".to_string()));
    }
    Ok(Some(workspace_id))
}

/// `parseBoundedIntOrFallback` — `params.ts:17-24`.
fn parse_bounded_int_or_fallback(raw: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    let Some(raw) = raw else {
        return fallback;
    };
    if raw.is_empty() {
        return fallback;
    }
    let parsed = raw
        .trim()
        .parse::<f64>()
        .unwrap_or(if raw.trim().is_empty() { 0.0 } else { f64::NAN });
    if !parsed.is_finite() {
        return fallback;
    }
    (parsed.floor() as i64).clamp(min, max)
}

/// `parseFlag` — `shared.ts:166-171`.
fn parse_flag(raw: Option<&str>) -> bool {
    let value = raw.unwrap_or("").trim().to_lowercase();
    matches!(value.as_str(), "1" | "true" | "yes" | "on")
}

/// `parseOptionalType` — `shared.ts:173-182`.
fn parse_optional_type(raw: Option<&str>) -> Result<Option<MemoryType>, ApiError> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty() || value == "all" {
        return Ok(None);
    }
    MemoryType::parse(value)
        .map(Some)
        .ok_or_else(|| ApiError::Validation("Invalid memory type.".to_string()))
}

/// `isDeleteAllConfirmed` — `shared.ts:218-224`.
fn is_delete_all_confirmed(raw: Option<&str>) -> bool {
    raw.unwrap_or("").trim().to_lowercase() == DELETE_ALL_CONFIRM_TOKEN
}

/// The parsed body of `parseStoreArgs` — `types.ts:9-15`.
struct ParsedStoreArgs {
    persona_id: String,
    workspace_id: Option<String>,
    node_type: MemoryType,
    content: String,
    importance: f64,
}

/// `parseStoreArgs` — `shared.ts:38-55`.
fn parse_store_args(raw: &Map<String, Value>) -> Result<ParsedStoreArgs, ApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;
    let node_type = js_or_empty(raw.get("type")).trim().to_string();
    let content = js_or_empty(raw.get("content")).trim().to_string();
    let importance_raw = match raw.get("importance") {
        None | Some(Value::Null) => 3.0,
        other => js_number(other),
    };
    let importance = if importance_raw.is_finite() {
        importance_raw.round().clamp(1.0, 5.0)
    } else {
        3.0
    };

    let Some(node_type) = MemoryType::parse(&node_type) else {
        return Err(ApiError::Validation("Invalid memory type.".to_string()));
    };
    if content.is_empty() {
        return Err(ApiError::Validation("content is required.".to_string()));
    }
    Ok(ParsedStoreArgs {
        persona_id,
        workspace_id,
        node_type,
        content,
        importance,
    })
}

/// The parsed body of `parseRecallArgs` — `types.ts:17-22`.
struct ParsedRecallArgs {
    persona_id: String,
    workspace_id: Option<String>,
    query: String,
    limit: i64,
}

/// `parseRecallArgs` — `shared.ts:57-67`.
fn parse_recall_args(raw: &Map<String, Value>) -> Result<ParsedRecallArgs, ApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;
    let query = js_or_empty(raw.get("query")).trim().to_string();
    let limit_raw = match raw.get("limit") {
        None | Some(Value::Null) => 3.0,
        other => js_number(other),
    };
    let limit = if limit_raw.is_finite() {
        (limit_raw.floor() as i64).clamp(1, 20)
    } else {
        3
    };
    if query.is_empty() {
        return Err(ApiError::Validation("query is required.".to_string()));
    }
    Ok(ParsedRecallArgs {
        persona_id,
        workspace_id,
        query,
        limit,
    })
}

/// The parsed body of `parseUpdateBody` — `types.ts:24-33`.
#[derive(Default)]
struct ParsedUpdateBody {
    persona_id: String,
    workspace_id: Option<String>,
    id: String,
    node_type: Option<MemoryType>,
    content: Option<String>,
    importance: Option<f64>,
    expected_version: Option<f64>,
    restore_index: Option<i64>,
}

/// A JavaScript number that stayed finite after `Math.floor`, or `NaN`.
fn js_floor_or_nan(raw: &Value) -> f64 {
    let value = js_number(Some(raw));
    if value.is_finite() {
        value.floor()
    } else {
        f64::NAN
    }
}

/// `parseUpdateBody` — `shared.ts:98-164`.
fn parse_update_body(raw: &Map<String, Value>) -> Result<ParsedUpdateBody, ApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let id = parse_memory_node_id(raw.get("id"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;

    let mut parsed = ParsedUpdateBody {
        persona_id,
        workspace_id,
        id,
        ..ParsedUpdateBody::default()
    };

    if let Some(value) = raw.get("type") {
        let node_type = js_or_empty(Some(value)).trim().to_string();
        let Some(node_type) = MemoryType::parse(&node_type) else {
            return Err(ApiError::Validation("Invalid memory type.".to_string()));
        };
        parsed.node_type = Some(node_type);
    }

    if let Some(value) = raw.get("content") {
        let content = js_or_empty(Some(value)).trim().to_string();
        if content.is_empty() {
            return Err(ApiError::Validation(
                "content must not be empty.".to_string(),
            ));
        }
        parsed.content = Some(content);
    }

    if let Some(value) = raw.get("importance") {
        let importance_raw = js_number(Some(value));
        let importance = if importance_raw.is_finite() {
            importance_raw.round().clamp(1.0, 5.0)
        } else {
            f64::NAN
        };
        if !importance.is_finite() {
            return Err(ApiError::Validation(
                "importance must be numeric.".to_string(),
            ));
        }
        parsed.importance = Some(importance);
    }

    if let Some(value) = raw.get("expectedVersion") {
        let expected_version = js_floor_or_nan(value);
        if !expected_version.is_finite() || expected_version < 1.0 {
            return Err(ApiError::Validation(
                "expectedVersion must be a positive integer.".to_string(),
            ));
        }
        parsed.expected_version = Some(expected_version);
    }

    if let Some(value) = raw.get("restoreIndex") {
        let restore_index = js_floor_or_nan(value);
        if !restore_index.is_finite() || restore_index < 0.0 {
            return Err(ApiError::Validation(
                "restoreIndex must be a non-negative integer.".to_string(),
            ));
        }
        parsed.restore_index = Some(restore_index as i64);
    }

    if parsed.restore_index.is_some() {
        if parsed.node_type.is_some() || parsed.content.is_some() || parsed.importance.is_some() {
            return Err(ApiError::Validation(
                "restoreIndex cannot be combined with type/content/importance updates.".to_string(),
            ));
        }
        return Ok(parsed);
    }

    if parsed.node_type.is_none() && parsed.content.is_none() && parsed.importance.is_none() {
        return Err(ApiError::Validation("No fields to update.".to_string()));
    }

    Ok(parsed)
}

/// The `action` of `parseBulkBody` — `types.ts:39`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BulkAction {
    Update,
    Delete,
}

/// The parsed body of `parseBulkBody` — `types.ts:35-41`.
struct ParsedBulkBody {
    persona_id: String,
    workspace_id: Option<String>,
    ids: Vec<String>,
    action: BulkAction,
    updates: BulkUpdatePatch,
}

/// `String(raw)` for the `parseBoundedIntOrFallback(raw.importance, …)` call.
fn js_string_for_number(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        other => betaclaw_core::memory::types::js_string(Some(other)),
    }
}

/// `parseBulkBody` — `shared.ts:184-216`.
fn parse_bulk_body(raw: &Map<String, Value>) -> Result<ParsedBulkBody, ApiError> {
    let persona_id = parse_persona_id(raw.get("personaId"))?;
    let workspace_id = parse_optional_workspace_id(raw.get("workspaceId"))?;

    let mut ids: Vec<String> = Vec::new();
    if let Some(Value::Array(entries)) = raw.get("ids") {
        for entry in entries {
            let id = js_or_empty(Some(entry)).trim().to_string();
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return Err(ApiError::Validation(
            "ids must be a non-empty array.".to_string(),
        ));
    }

    let action_raw = js_or_empty(raw.get("action")).trim().to_lowercase();
    let action = match action_raw.as_str() {
        "update" => BulkAction::Update,
        "delete" => BulkAction::Delete,
        _ => {
            return Err(ApiError::Validation(
                "action must be either \"update\" or \"delete\".".to_string(),
            ));
        }
    };

    let mut updates = BulkUpdatePatch::default();
    if let Some(value) = raw.get("type") {
        updates.node_type = parse_optional_type(Some(&js_or_empty(Some(value))))?;
    }
    if let Some(value) = raw.get("importance") {
        let text = js_string_for_number(value);
        updates.importance = Some(parse_bounded_int_or_fallback(Some(&text), 3, 1, 5) as f64);
    }

    if action == BulkAction::Update && updates.node_type.is_none() && updates.importance.is_none() {
        return Err(ApiError::Validation(
            "Bulk update requires at least one update field.".to_string(),
        ));
    }

    Ok(ParsedBulkBody {
        persona_id,
        workspace_id,
        ids,
        action,
        updates,
    })
}

/// `resolveMemoryReadUserScopes` — `shared.ts:226-249`.
///
/// The conversation list is passed in so the store call stays outside the pure
/// scope rule; a store failure means the scope list is just the base user id,
/// exactly like the `catch` in the TypeScript.
fn resolve_memory_read_user_scopes(
    base_user_id: &str,
    persona_id: &str,
    conversations: &[Conversation],
) -> Vec<String> {
    let normalized_user_id = base_user_id.trim().to_string();
    if normalized_user_id.is_empty() {
        return Vec::new();
    }
    if normalized_user_id != LEGACY_LOCAL_USER_ID {
        return vec![normalized_user_id];
    }

    let mut scopes: Vec<String> = vec![normalized_user_id.clone()];
    for conversation in conversations {
        let channel = conversation.channel_type.trim().to_lowercase();
        let external_chat_id = conversation.external_chat_id.clone().unwrap_or_default();
        let conversation_persona_id = conversation.persona_id.clone().unwrap_or_default();
        if channel.is_empty() || external_chat_id.trim().is_empty() || channel == "webchat" {
            continue;
        }
        if !conversation_persona_id.trim().is_empty() && conversation_persona_id != persona_id {
            continue;
        }
        let scope = format!("channel:{channel}:{}", external_chat_id.trim());
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }

    scopes
}

/// `NextResponse.json({ node })` — one [`MemoryNode`] as JSON.
fn node_json(node: &betaclaw_core::memory::types::MemoryNode) -> Value {
    serde_json::to_value(node).unwrap_or(Value::Null)
}

/// One `MemoryHistoryRecord` as JSON — `types.ts:16-25` spells `type`.
fn history_entry_json(entry: &betaclaw_core::memory::types::MemoryHistoryRecord) -> Value {
    let mut object = Map::new();
    object.insert("index".to_string(), json!(entry.index));
    object.insert("action".to_string(), json!(entry.action));
    object.insert("timestamp".to_string(), json!(entry.timestamp));
    if let Some(content) = &entry.content {
        object.insert("content".to_string(), json!(content));
    }
    if let Some(node_type) = entry.node_type {
        object.insert("type".to_string(), json!(node_type.as_str()));
    }
    if let Some(importance) = entry.importance {
        object.insert("importance".to_string(), json!(importance));
    }
    if let Some(version) = entry.version {
        object.insert("version".to_string(), json!(version));
    }
    object.insert(
        "metadata".to_string(),
        Value::Object(entry.metadata.clone()),
    );
    Value::Object(object)
}

/// `parsePersonaId(url.searchParams.get(…))` — `getHandler.ts:18`.
fn parse_persona_id_str(raw: Option<&str>) -> Result<String, ApiError> {
    let persona_id = raw.unwrap_or("").trim().to_string();
    if persona_id.is_empty() {
        return Err(ApiError::Validation("personaId is required.".to_string()));
    }
    Ok(persona_id)
}

/// `parseOptionalWorkspaceId(url.searchParams.get(…))` — `getHandler.ts:19`.
fn parse_optional_workspace_id_str(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    parse_optional_workspace_id(Some(&Value::String(raw.unwrap_or("").to_string())))
}

/// `GET /api/memory` — `getHandler.ts:15-110`.
async fn handle_get(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };

    let persona_id = match parse_persona_id_str(params.get("personaId").map(String::as_str)) {
        Ok(persona_id) => persona_id,
        Err(error) => return error_response(error),
    };
    let workspace_id =
        match parse_optional_workspace_id_str(params.get("workspaceId").map(String::as_str)) {
            Ok(workspace_id) => workspace_id,
            Err(error) => return error_response(error),
        };
    let node_id = params
        .get("id")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let include_history = parse_flag(params.get("history").map(String::as_str));
    let preview = parse_flag(params.get("preview").map(String::as_str));
    let preview_limit =
        parse_bounded_int_or_fallback(params.get("limit").map(String::as_str), 50, 1, 200);
    let page_param = params.contains_key("page");
    let page_size_param = params.contains_key("pageSize");
    let page =
        parse_bounded_int_or_fallback(params.get("page").map(String::as_str), 1, 1, 1_000_000);
    let page_size =
        parse_bounded_int_or_fallback(params.get("pageSize").map(String::as_str), 25, 1, 200);
    if (page - 1) * page_size + page_size > 10_000 {
        return error_response(ApiError::Validation(
            "Memory pagination is limited to the first 10,000 results. Narrow the query or filters."
                .to_string(),
        ));
    }

    let conversations = if user_id == LEGACY_LOCAL_USER_ID {
        match state
            .messages
            .lock()
            .await
            .list_conversations(500, Some(&user_id))
        {
            Ok(conversations) => conversations,
            Err(error) => {
                tracing::warn!("Memory scope discovery failed: {error}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let user_scopes = resolve_memory_read_user_scopes(&user_id, &persona_id, &conversations);
    let primary_user_scope = user_scopes
        .first()
        .cloned()
        .unwrap_or_else(|| user_id.clone());
    let scopes = if user_scopes.is_empty() {
        vec![primary_user_scope.clone()]
    } else {
        user_scopes.clone()
    };

    let context = match MemoryContext::build(&state).await {
        Ok(context) => context,
        Err(error) => return error_response(error),
    };
    let service = match ready_service(&context) {
        Ok(service) => Some(service),
        Err(ApiError::Unavailable) => None,
        Err(error) => return error_response(error),
    };
    let Some(service) = service else {
        if include_history {
            return json_response(
                StatusCode::OK,
                json!({ "ok": true, "node": null, "history": [], "degraded": true }),
            );
        }
        if page_param || page_size_param {
            return json_response(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "nodes": [],
                    "pagination": { "page": page, "pageSize": page_size, "total": 0, "totalPages": 1 },
                    "degraded": true
                }),
            );
        }
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "nodes": [], "degraded": true }),
        );
    };

    if include_history {
        if node_id.is_empty() {
            return error_response(ApiError::Validation(
                "id is required when history is requested.".to_string(),
            ));
        }
        let result = match service.history(
            &persona_id,
            &node_id,
            Some(&primary_user_scope),
            workspace_id.as_deref(),
        ) {
            Ok(result) => result,
            Err(error) => return error_response(map_memory_error(error)),
        };
        let Some(result) = result else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({ "ok": false, "error": "Memory node not found." }),
            );
        };
        let history: Vec<Value> = result.entries.iter().map(history_entry_json).collect();
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "node": node_json(&result.node), "history": history }),
        );
    }

    if preview {
        let result = match service.list_preview_across_scopes(
            &persona_id,
            &scopes,
            preview_limit,
            workspace_id.as_deref(),
        ) {
            Ok(result) => result,
            Err(error) => return error_response(map_memory_error(error)),
        };
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "nodes": result.nodes, "truncated": result.truncated }),
        );
    }

    if page_param || page_size_param {
        let query = params
            .get("query")
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let node_type = match parse_optional_type(params.get("type").map(String::as_str)) {
            Ok(node_type) => node_type,
            Err(error) => return error_response(error),
        };
        let input = MemoryPageRequest {
            page,
            page_size,
            query: if query.is_empty() { None } else { Some(query) },
            node_type,
        };
        let result = if user_scopes.len() > 1 {
            service.list_page_across_scopes(&persona_id, &scopes, &input, workspace_id.as_deref())
        } else {
            service.list_page(
                &persona_id,
                &input,
                Some(&primary_user_scope),
                workspace_id.as_deref(),
            )
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => return error_response(map_memory_error(error)),
        };
        let pagination = result.pagination;
        return json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "nodes": result.nodes,
                "pagination": {
                    "page": pagination.page,
                    "pageSize": pagination.page_size,
                    "total": pagination.total,
                    "totalPages": pagination.total_pages
                }
            }),
        );
    }

    // Backward-compatible unpaged reads are bounded as well.
    let snapshot = match service.list_preview_across_scopes(
        &persona_id,
        &scopes,
        200,
        workspace_id.as_deref(),
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => return error_response(map_memory_error(error)),
    };
    json_response(
        StatusCode::OK,
        json!({ "ok": true, "nodes": snapshot.nodes, "truncated": snapshot.truncated }),
    )
}

/// `await request.json()` — the invalid-JSON `SyntaxError` maps to a 400.
fn parse_body(body: &Bytes) -> Result<Map<String, Value>, ApiError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| ApiError::Validation(error.to_string()))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Ok(Map::new()),
    }
}

/// `const args = body.args || {}` — `postHandler.ts:15`.
fn object_or_empty(raw: Option<&Value>) -> Map<String, Value> {
    match raw {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// `POST /api/memory` — `postHandler.ts:11-56`.
async fn handle_post(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let raw = match parse_body(&body) {
        Ok(raw) => raw,
        Err(error) => return error_response(error),
    };
    let fc_name = js_or_empty(raw.get("fcName")).trim().to_string();
    let args = object_or_empty(raw.get("args"));

    let context = match MemoryContext::build(&state).await {
        Ok(context) => context,
        Err(error) => return error_response(error),
    };
    let service = match ready_service(&context) {
        Ok(service) => service,
        Err(error) => return error_response(error),
    };

    if fc_name == "core_memory_store" {
        let parsed = match parse_store_args(&args) {
            Ok(parsed) => parsed,
            Err(error) => return error_response(error),
        };
        let node = match service.store_memory(&MemoryStoreInput {
            persona_id: parsed.persona_id,
            workspace_id: parsed.workspace_id,
            node_type: parsed.node_type,
            content: parsed.content,
            importance: parsed.importance,
            user_id: Some(user_id),
            metadata: empty_metadata(),
        }) {
            Ok(node) => node,
            Err(error) => return error_response(map_memory_error(error)),
        };
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "result": { "action": "store", "data": node_json(&node) } }),
        );
    }

    if fc_name == "core_memory_recall" {
        let parsed = match parse_recall_args(&args) {
            Ok(parsed) => parsed,
            Err(error) => return error_response(error),
        };
        let context_text = match service.recall(
            &parsed.persona_id,
            &parsed.query,
            Some(parsed.limit),
            Some(&user_id),
            parsed.workspace_id.as_deref(),
        ) {
            Ok(context_text) => context_text,
            Err(error) => return error_response(map_memory_error(error)),
        };
        return json_response(
            StatusCode::OK,
            json!({ "ok": true, "result": { "action": "recall", "data": context_text } }),
        );
    }

    let label = if fc_name.is_empty() {
        "undefined".to_string()
    } else {
        fc_name
    };
    json_response(
        StatusCode::BAD_REQUEST,
        json!({ "ok": false, "error": format!("Unsupported function call: {label}") }),
    )
}

/// `PUT /api/memory` — `putHandler.ts:11-56`.
async fn handle_put(State(state): State<SharedState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let raw = match parse_body(&body) {
        Ok(raw) => raw,
        Err(error) => return error_response(error),
    };
    let parsed = match parse_update_body(&raw) {
        Ok(parsed) => parsed,
        Err(error) => return error_response(error),
    };

    let context = match MemoryContext::build(&state).await {
        Ok(context) => context,
        Err(error) => return error_response(error),
    };
    let service = match ready_service(&context) {
        Ok(service) => service,
        Err(error) => return error_response(error),
    };

    let node = if let Some(restore_index) = parsed.restore_index {
        service.restore_from_history(
            &parsed.persona_id,
            &parsed.id,
            &MemoryRestoreInput {
                restore_index,
                expected_version: parsed.expected_version,
            },
            Some(&user_id),
            parsed.workspace_id.as_deref(),
        )
    } else {
        service.update(
            &parsed.persona_id,
            &parsed.id,
            &MemoryUpdateInput {
                node_type: parsed.node_type,
                content: parsed.content,
                importance: parsed.importance,
                expected_version: parsed.expected_version,
                metadata: empty_metadata(),
            },
            Some(&user_id),
            parsed.workspace_id.as_deref(),
        )
    };

    match node {
        Ok(Some(node)) => json_response(
            StatusCode::OK,
            json!({ "ok": true, "node": node_json(&node) }),
        ),
        Ok(None) => json_response(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": "Memory node not found." }),
        ),
        Err(error) => error_response(map_memory_error(error)),
    }
}

/// `PATCH /api/memory` — `patchHandler.ts:10-44`.
async fn handle_patch(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let raw = match parse_body(&body) {
        Ok(raw) => raw,
        Err(error) => return error_response(error),
    };
    let parsed = match parse_bulk_body(&raw) {
        Ok(parsed) => parsed,
        Err(error) => return error_response(error),
    };

    let context = match MemoryContext::build(&state).await {
        Ok(context) => context,
        Err(error) => return error_response(error),
    };
    let service = match ready_service(&context) {
        Ok(service) => service,
        Err(error) => return error_response(error),
    };

    match parsed.action {
        BulkAction::Delete => {
            let affected = match service.bulk_delete(
                &parsed.persona_id,
                &parsed.ids,
                Some(&user_id),
                parsed.workspace_id.as_deref(),
            ) {
                Ok(affected) => affected,
                Err(error) => return error_response(map_memory_error(error)),
            };
            json_response(
                StatusCode::OK,
                json!({ "ok": true, "action": "delete", "affected": affected }),
            )
        }
        BulkAction::Update => {
            let affected = match service.bulk_update(
                &parsed.persona_id,
                &parsed.ids,
                parsed.updates,
                Some(&user_id),
                parsed.workspace_id.as_deref(),
            ) {
                Ok(affected) => affected,
                Err(error) => return error_response(map_memory_error(error)),
            };
            json_response(
                StatusCode::OK,
                json!({ "ok": true, "action": "update", "affected": affected }),
            )
        }
    }
}

/// `DELETE /api/memory` — `deleteHandler.ts:13-46`.
async fn handle_delete(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let persona_id = match parse_persona_id_str(params.get("personaId").map(String::as_str)) {
        Ok(persona_id) => persona_id,
        Err(error) => return error_response(error),
    };
    let workspace_id =
        match parse_optional_workspace_id_str(params.get("workspaceId").map(String::as_str)) {
            Ok(workspace_id) => workspace_id,
            Err(error) => return error_response(error),
        };
    let node_id = params
        .get("id")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();

    let context = match MemoryContext::build(&state).await {
        Ok(context) => context,
        Err(error) => return error_response(error),
    };
    let service = match ready_service(&context) {
        Ok(service) => service,
        Err(error) => return error_response(error),
    };

    if !node_id.is_empty() {
        let deleted = match service.delete(
            &persona_id,
            &node_id,
            Some(&user_id),
            workspace_id.as_deref(),
        ) {
            Ok(deleted) => deleted,
            Err(error) => return error_response(map_memory_error(error)),
        };
        let deleted = if deleted { 1 } else { 0 };
        return json_response(StatusCode::OK, json!({ "ok": true, "deleted": deleted }));
    }

    if !is_delete_all_confirmed(params.get("confirm").map(String::as_str)) {
        return error_response(ApiError::Validation(format!(
            "confirm={DELETE_ALL_CONFIRM_TOKEN} is required to delete all memory entries for a persona."
        )));
    }

    let deleted =
        match service.delete_by_persona(&persona_id, Some(&user_id), workspace_id.as_deref()) {
            Ok(deleted) => deleted,
            Err(error) => return error_response(map_memory_error(error)),
        };
    json_response(StatusCode::OK, json!({ "ok": true, "deleted": deleted }))
}

/// The router for `routes/mod.rs` — `app/api/memory/route.ts:8-22`.
///
/// The per-route fallback keeps unmatched methods compatible with the proxy.
pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/memory",
        get(handle_get)
            .post(handle_post)
            .put(handle_put)
            .delete(handle_delete)
            .patch(handle_patch)
            .fallback(proxy_to_upstream),
    )
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::Mutex;

    use super::*;
    use crate::routes::test_support::{send, state_in, ScratchDir};
    use axum::http::Method;
    use betaclaw_core::memory::types::MemoryProviderKind;
    use betaclaw_core::world_model::db::UnconfiguredPgExecutor;

    static MEMORY_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct MemoryEnvRestore(Vec<(&'static str, Option<OsString>)>);

    impl MemoryEnvRestore {
        fn use_sqlite(path: String) -> Self {
            let values = [
                ("MEMORY_PROVIDER", "sqlite".to_string()),
                ("MEMORY_DB_PATH", path),
                ("WORLD_MODEL_ENABLED", "false".to_string()),
                ("WORLD_MODEL_MODE", "shadow".to_string()),
                ("NODE_ENV", "test".to_string()),
            ];
            let previous = values
                .iter()
                .map(|(name, _)| (*name, std::env::var_os(name)))
                .collect();
            for (name, value) in values {
                std::env::set_var(name, value);
            }
            Self(previous)
        }
    }

    impl Drop for MemoryEnvRestore {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }

    #[test]
    fn postgres_provider_uses_the_world_model_executor() {
        let factory = GatewayMemoryClientFactory {
            transport: Arc::new(ReqwestTransport::new()),
            postgres_executor: Some(Arc::new(UnconfiguredPgExecutor)),
        };

        let client = factory
            .create(ConfiguredProvider::Postgres, &HashMap::new())
            .expect("configured executor creates the canonical memory client");

        assert_eq!(client.provider(), Some(MemoryProviderKind::Postgres));
    }

    #[tokio::test]
    async fn expired_recall_publishes_through_the_app_state_lifecycle_bus() {
        let _lock = MEMORY_ENV_LOCK.lock().await;
        let scratch = ScratchDir::new();
        let _env = MemoryEnvRestore::use_sqlite(scratch.path_string("memory.db"));
        let state = state_in(&scratch);
        let received = Arc::new(Mutex::new(Vec::new()));
        let handler_events = Arc::clone(&received);
        let _subscription = state.memory_lifecycle_bus.subscribe(move |change| {
            handler_events.lock().expect("lock").push(change.clone());
        });

        let context = MemoryContext::build(&state).await.expect("memory context");
        let service = ready_service(&context).expect("memory service");
        let mut metadata = Map::new();
        metadata.insert(
            "lifecycleStatus".to_string(),
            Value::String("confirmed".to_string()),
        );
        metadata.insert(
            "expiresAt".to_string(),
            Value::String("2020-01-01T00:00:00.000Z".to_string()),
        );
        let stored = service
            .store_memory(&MemoryStoreInput {
                persona_id: "persona-1".to_string(),
                workspace_id: None,
                node_type: MemoryType::Fact,
                content: "expired lifecycle fact".to_string(),
                importance: 3.0,
                user_id: Some("user-1".to_string()),
                metadata,
            })
            .expect("seed memory");
        drop(service);
        drop(context);

        let (status, _) = send(
            &state,
            Method::POST,
            "/api/memory",
            Some("user-1"),
            Some(
                r#"{"fcName":"core_memory_recall","args":{"personaId":"persona-1","query":"expired"}}"#,
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let events = received.lock().expect("lock");
        assert!(!events.is_empty(), "recall should publish the expiry event");
        assert!(events.iter().all(|event| {
            event.memory_id == stored.id
                && event.user_id == "user-1"
                && event.persona_id == "persona-1"
                && event.status.as_str() == "stale"
                && event.signal.as_str() == "time_expired"
                && event.provider == MemoryProviderKind::Mem0
        }));
    }
}
