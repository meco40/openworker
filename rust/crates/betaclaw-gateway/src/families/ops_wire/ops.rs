//! Ops routes: instances, nodes and sessions.
//!
//! Port of `app/api/ops/instances/route.ts` (GET), `app/api/ops/nodes/route.ts`
//! (GET, POST) and `app/api/ops/sessions/route.ts` (GET). `app/api/ops/_shared/query.ts`
//! is the `clamped_int` helper of the parent module.
//!
//! Nodes aggregates the channel bindings (S8), the automation scheduler (S10), the
//! exec approvals (S11) and the personas. Health and doctor come from the
//! diagnostics port. A failing port call is a 500 with its message, as the
//! TypeScript `catch` returns.
//!
//! Not carried over: `requestCount` and `seq` of an instance connection. The Rust
//! `ClientHandle` does not keep them, so they are `null`.

use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use betaclaw_core::auth::policy::{constant_time_eq, is_loopback_address, strip_bearer};
use betaclaw_core::automation::types::AutomationRunStatus;
use betaclaw_core::messages_store::{ChannelBinding, Conversation};
use chrono::DateTime;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use super::ports::PortError;
use super::{
    clamped_int, error_json, iso_from_ms, js_parse_int, now_iso, query_param, require_user,
    Services,
};
use crate::state::SharedState;

pub(super) fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/ops/instances", get(instances))
        .route("/api/ops/nodes", get(nodes_get).post(nodes_post))
        .route("/api/ops/sessions", get(sessions))
}

/// The socket peer of a request, read from `ConnectInfo` as `auth_gate` reads it. A
/// request without connection info (an in-process call) has no peer. Never rejects.
struct SocketPeer(Option<String>);

impl<S> FromRequestParts<S> for SocketPeer
where
    S: Send + Sync,
{
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip().to_string());
        Ok(Self(peer))
    }
}

/// The admin of the gateway, as the gate defines the operator: a request from a
/// loopback socket, or one whose bearer token is `MC_API_TOKEN`. The loopback marker
/// header is not read, because the gate does not strip an inbound value on direct routes.
fn caller_is_admin(state: &SharedState, headers: &HeaderMap, peer: &SocketPeer) -> bool {
    if is_loopback_address(peer.0.as_deref()) {
        return true;
    }
    let supplied = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(strip_bearer);
    match (state.config.mc_api_token.as_deref(), supplied) {
        (Some(expected), Some(supplied)) => {
            constant_time_eq(supplied.as_bytes(), expected.as_bytes())
        }
        _ => false,
    }
}

/// Allowlist of the actions a non-admin may run. Every other action, including the
/// `telegram.*` pairing actions, needs the admin. TS has no such gate at all
/// (`route.ts` runs every mutation for any caller): deliberate deviation, see
/// `docs/RUST_MIGRATION.md`.
fn action_requires_admin(action: &str) -> bool {
    action != "bindings.setPersona"
}

/// `GET /api/ops/instances`
async fn instances(State(state): State<SharedState>, headers: HeaderMap, uri: Uri) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let limit = clamped_int(&uri, "limit", 25, 1, 100) as usize;
    let registry = &state.registry;
    let clients = registry.get_by_user_id(&user_id);
    let connections: Vec<Value> = clients
        .iter()
        .take(limit)
        .map(|client| {
            json!({
                "connId": &*client.conn_id,
                "connectedAt": iso_from_ms(client.connected_at() as i64),
                "subscriptionCount": client.subscriptions().len(),
                "requestCount": Value::Null,
                "seq": Value::Null,
            })
        })
        .collect();
    Json(json!({
        "ok": true,
        "instances": {
            "global": {
                "connectionCount": registry.connection_count(),
                "userCount": registry.user_count(),
            },
            "currentUser": {
                "connectionCount": clients.len(),
                "connections": connections,
            },
            "generatedAt": now_iso(),
        },
    }))
    .into_response()
}

/// A failure of the nodes route, with the status it answers.
struct NodesError {
    status: StatusCode,
    message: String,
}

impl NodesError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn failed(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }

    fn into_response(self) -> Response {
        error_json(self.status, self.message)
    }
}

/// `CHANNEL_CAPABILITIES` (`src/server/channels/adapters/capabilities.ts`), in
/// the object's key order.
#[derive(Clone, Copy)]
struct Capabilities {
    inbound: bool,
    outbound: bool,
    pairing: bool,
    streaming: bool,
}

const fn caps(inbound: bool, outbound: bool, pairing: bool, streaming: bool) -> Capabilities {
    Capabilities {
        inbound,
        outbound,
        pairing,
        streaming,
    }
}

const CHANNEL_CAPABILITIES: [(&str, Capabilities); 7] = [
    ("webchat", caps(true, false, false, true)),
    ("agent_room", caps(true, false, false, true)),
    ("telegram", caps(true, true, true, false)),
    ("whatsapp", caps(true, true, true, false)),
    ("discord", caps(true, true, true, false)),
    ("imessage", caps(true, true, true, false)),
    ("slack", caps(true, true, true, false)),
];

/// `isPairChannelType` of the pairing module.
fn is_pair_channel(channel: &str) -> bool {
    matches!(
        channel,
        "whatsapp" | "telegram" | "discord" | "imessage" | "slack"
    )
}

/// `parseMemoryDiagnosticsEnabled` of the nodes route.
pub(super) fn memory_diagnostics_flag(uri: &Uri) -> bool {
    query_param(uri, "memoryDiagnostics")
        .map(|raw| raw.trim().to_ascii_lowercase())
        .is_some_and(|raw| matches!(raw.as_str(), "1" | "true" | "on" | "yes"))
}

/// `parseString` of the nodes route: a trimmed string, or the TypeScript error.
fn parse_string(
    value: Option<&Value>,
    field: &str,
    required: bool,
) -> Result<Option<String>, NodesError> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                Ok(Some(trimmed.to_string()))
            } else if required {
                Err(NodesError::bad(format!("{field} is required.")))
            } else {
                Ok(None)
            }
        }
        _ if required => Err(NodesError::bad(format!("{field} must be a string."))),
        _ => Ok(None),
    }
}

/// `parseChannelKey`: a key of `CHANNEL_CAPABILITIES`, matched exactly.
fn parse_channel_key(value: Option<&Value>) -> Result<String, NodesError> {
    let channel = parse_string(value, "channel", true)?.unwrap_or_default();
    if CHANNEL_CAPABILITIES.iter().any(|(key, _)| *key == channel) {
        Ok(channel)
    } else {
        Err(NodesError::bad("Unsupported channel."))
    }
}

/// `normalizeBridgeAccountId`: the trimmed id, or `default`.
fn normalize_bridge_account_id(value: Option<String>) -> String {
    value.unwrap_or_else(|| "default".to_string())
}

/// `automation` of the nodes payload and `getAutomationService().getMetrics()`.
/// Mirrors `AutomationService::get_metrics`, which reads the same repository.
pub(super) async fn automation_metrics(services: &Services) -> Result<Value, String> {
    let repo = services.automation.lock().await;
    let lease_age_seconds = repo
        .get_lease_state()
        .map_err(|error| error.to_string())?
        .and_then(|lease| {
            let updated = DateTime::parse_from_rfc3339(&lease.updated_at).ok()?;
            let age_ms = chrono::Utc::now().timestamp_millis() - updated.timestamp_millis();
            Some(age_ms.div_euclid(1000))
        });
    let count = |status| repo.count_runs_by_status(status).map_err(|e| e.to_string());
    Ok(json!({
        "activeRules": repo.count_active_rules().map_err(|e| e.to_string())?,
        "queuedRuns": count(AutomationRunStatus::Queued)?,
        "runningRuns": count(AutomationRunStatus::Running)?,
        "deadLetterRuns": count(AutomationRunStatus::DeadLetter)?,
        "leaseAgeSeconds": lease_age_seconds,
    }))
}

/// A port call that may be missing. `NotWired` yields `None`, any other error stays.
fn optional_port<T>(result: Result<T, PortError>) -> Result<Option<T>, NodesError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(PortError::NotWired(_)) => Ok(None),
        Err(error) => Err(NodesError::failed(error)),
    }
}

/// `channels` of the nodes payload, the first `limit` entries of `CHANNEL_CAPABILITIES`.
async fn channel_summaries(
    state: &SharedState,
    services: &Services,
    user_id: &str,
    limit: usize,
) -> Result<Vec<Value>, NodesError> {
    let bindings = state
        .messages
        .lock()
        .await
        .list_channel_bindings(user_id)
        .map_err(NodesError::failed)?;
    let by_channel: HashMap<&str, &ChannelBinding> = bindings
        .iter()
        .map(|binding| (binding.channel.as_str(), binding))
        .collect();

    let mut summaries = Vec::new();
    for (channel, capabilities) in CHANNEL_CAPABILITIES.iter().take(limit) {
        let binding = by_channel.get(channel).copied();
        let mut summary = json!({
            "channel": channel,
            "status": binding.map_or("idle", |b| b.status.as_str()),
            "externalPeerId": binding.and_then(|b| b.external_peer_id.clone()),
            "peerName": binding.and_then(|b| b.peer_name.clone()),
            "transport": binding.and_then(|b| b.transport.clone()),
            "personaId": binding.and_then(|b| b.persona_id.clone()),
            "lastSeenAt": binding.and_then(|b| b.last_seen_at.clone()),
            "supportsInbound": capabilities.inbound,
            "supportsOutbound": capabilities.outbound,
            "supportsPairing": capabilities.pairing,
            "supportsStreaming": capabilities.streaming,
        });
        if matches!(*channel, "whatsapp" | "imessage") {
            let accounts = optional_port(
                services
                    .channel_pairing
                    .bridge_accounts((*channel).to_string())
                    .await,
            )?;
            if let (Some(accounts), Some(object)) = (accounts, summary.as_object_mut()) {
                object.insert("accounts".to_string(), accounts);
            }
        }
        summaries.push(summary);
    }
    Ok(summaries)
}

/// `buildNodesPayload` of the nodes route.
async fn nodes_payload(
    state: &SharedState,
    services: &Services,
    user_id: &str,
    memory_diagnostics: bool,
    channel_limit: usize,
    mutation: Option<Value>,
    include_exec_approvals: bool,
) -> Result<Value, NodesError> {
    let (health, doctor) = tokio::try_join!(
        services.diagnostics.health(memory_diagnostics),
        services.diagnostics.doctor(memory_diagnostics),
    )
    .map_err(NodesError::failed)?;

    let channels = channel_summaries(state, services, user_id, channel_limit).await?;
    let personas = state
        .personas
        .lock()
        .await
        .list_personas(user_id)
        .map_err(NodesError::failed)?
        .into_iter()
        .map(|persona| {
            json!({
                "id": persona.id,
                "name": persona.name,
                "emoji": persona.emoji,
                "vibe": persona.vibe,
                "updatedAt": persona.updated_at,
            })
        })
        .collect::<Vec<_>>();
    let automation = automation_metrics(services)
        .await
        .map_err(NodesError::failed)?;
    // Exec approvals are admin data: other callers see an empty list.
    let approvals = if include_exec_approvals {
        services.exec_approvals.list()
    } else {
        Vec::new()
    };
    let approval_items: Vec<Value> = approvals
        .iter()
        .map(|entry| {
            json!({
                "fingerprint": entry.fingerprint,
                "command": entry.command,
                "updatedAt": entry.updated_at,
            })
        })
        .collect();
    // Pairing requests carry codes, so they are admin data like the exec approvals.
    let telegram_pairing = if include_exec_approvals {
        optional_port(services.channel_pairing.telegram_pairing().await)?
    } else {
        None
    };

    let mut payload = Map::new();
    payload.insert("ok".to_string(), Value::Bool(true));
    if let Some(mutation) = mutation {
        payload.insert("mutation".to_string(), mutation);
    }
    payload.insert(
        "nodes".to_string(),
        json!({
            "health": {
                "status": pick(&health, "status"),
                "summary": pick(&health, "summary"),
                "generatedAt": pick(&health, "generatedAt"),
            },
            "doctor": {
                "status": pick(&doctor, "status"),
                "findings": doctor.get("findings").and_then(Value::as_array).map_or(0, Vec::len),
                "recommendations": doctor
                    .get("recommendations")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
                "generatedAt": pick(&doctor, "generatedAt"),
            },
            "channels": channels,
            "automation": automation,
            "personas": personas,
            "execApprovals": {
                "total": approval_items.len(),
                "items": approval_items,
            },
            "telegramPairing": telegram_pairing,
            "generatedAt": now_iso(),
        }),
    );
    Ok(Value::Object(payload))
}

fn pick(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

/// `GET /api/ops/nodes`
async fn nodes_get(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    peer: SocketPeer,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let admin = caller_is_admin(&state, &headers, &peer);
    let channel_limit = clamped_int(&uri, "limit", 50, 1, 200) as usize;
    match nodes_payload(
        &state,
        &services,
        &user_id,
        memory_diagnostics_flag(&uri),
        channel_limit,
        None,
        admin,
    )
    .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => error.into_response(),
    }
}

/// `POST /api/ops/nodes`: one action, then the refreshed payload.
async fn nodes_post(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    peer: SocketPeer,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let fields = match &value {
        Value::Object(fields) => fields.clone(),
        // `body.action` on null throws in TypeScript, which the catch turns into a 500.
        Value::Null => {
            return error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Cannot read properties of null (reading 'action')",
            )
        }
        _ => Map::new(),
    };

    let admin = caller_is_admin(&state, &headers, &peer);
    let action = fields
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if action_requires_admin(action) && !admin {
        return error_json(StatusCode::FORBIDDEN, "Forbidden");
    }

    let mutation = match apply_mutation(&state, &services, &user_id, &fields).await {
        Ok(mutation) => mutation,
        Err(error) => return error.into_response(),
    };
    match nodes_payload(
        &state,
        &services,
        &user_id,
        false,
        50,
        Some(mutation),
        admin,
    )
    .await
    {
        Ok(payload) => Json(payload).into_response(),
        Err(error) => error.into_response(),
    }
}

/// `applyMutation`: dispatches on `action`.
async fn apply_mutation(
    state: &SharedState,
    services: &Services,
    user_id: &str,
    body: &Map<String, Value>,
) -> Result<Value, NodesError> {
    let action = parse_string(body.get("action"), "action", true)?.unwrap_or_default();
    match action.as_str() {
        "bindings.setPersona" => {
            let channel = parse_channel_key(body.get("channel"))?;
            let persona_id = match body.get("personaId") {
                Some(Value::String(text)) => {
                    Some(text.trim().to_string()).filter(|id| !id.is_empty())
                }
                _ => None,
            };
            if let Some(persona_id) = &persona_id {
                let personas = state
                    .personas
                    .lock()
                    .await
                    .list_personas(user_id)
                    .map_err(NodesError::failed)?;
                if !personas.iter().any(|persona| &persona.id == persona_id) {
                    return Err(NodesError::bad("Unknown personaId."));
                }
            }
            state
                .messages
                .lock()
                .await
                .update_channel_binding_persona(user_id, &channel, persona_id.as_deref())
                .map_err(NodesError::failed)?;
            Ok(json!({
                "action": "bindings.setPersona",
                "channel": channel,
                "personaId": persona_id,
            }))
        }
        "channels.connect" => {
            let channel = parse_string(body.get("channel"), "channel", true)?.unwrap_or_default();
            if !is_pair_channel(&channel) {
                return Err(NodesError::bad("Unsupported channel for pairing."));
            }
            let token = match body.get("token") {
                Some(Value::String(text)) => text.clone(),
                _ => String::new(),
            };
            let account_id = parse_string(body.get("accountId"), "accountId", false)?;
            let paired = services
                .channel_pairing
                .connect(channel.clone(), token, account_id.clone())
                .await
                .map_err(NodesError::failed)?;
            let status = paired
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("connected");
            let mut mutation = json!({
                "action": "channels.connect",
                "channel": channel,
                "status": status,
            });
            if let (Some(account_id), Some(object)) = (account_id, mutation.as_object_mut()) {
                object.insert("accountId".to_string(), Value::String(account_id));
            }
            Ok(mutation)
        }
        "channels.disconnect" => {
            let channel = parse_string(body.get("channel"), "channel", true)?.unwrap_or_default();
            if !is_pair_channel(&channel) {
                return Err(NodesError::bad("Unsupported channel for unpair."));
            }
            let account_id = parse_string(body.get("accountId"), "accountId", false)?;
            services
                .channel_pairing
                .disconnect(channel.clone(), account_id.clone())
                .await
                .map_err(NodesError::failed)?;
            Ok(json!({
                "action": "channels.disconnect",
                "channel": channel,
                "accountId": account_id.unwrap_or_else(|| "default".to_string()),
            }))
        }
        "channels.rotateSecret" => {
            let channel = parse_string(body.get("channel"), "channel", true)?.unwrap_or_default();
            if channel != "whatsapp" && channel != "imessage" {
                return Err(NodesError::bad(
                    "Secret rotation is only supported for bridge channels.",
                ));
            }
            let account_id = normalize_bridge_account_id(parse_string(
                body.get("accountId"),
                "accountId",
                false,
            )?);
            services
                .channel_pairing
                .rotate_secret(channel.clone(), account_id.clone())
                .await
                .map_err(NodesError::failed)?;
            Ok(json!({
                "action": "channels.rotateSecret",
                "channel": channel,
                "accountId": account_id,
                "rotatedAt": now_iso(),
            }))
        }
        "exec.approve" => {
            let command = parse_string(body.get("command"), "command", true)?.unwrap_or_default();
            services
                .exec_approvals
                .approve(&command)
                .map_err(NodesError::failed)?;
            Ok(json!({ "action": "exec.approve", "command": command }))
        }
        "exec.revoke" => {
            let command = parse_string(body.get("command"), "command", true)?.unwrap_or_default();
            let revoked = services
                .exec_approvals
                .revoke(&command)
                .map_err(NodesError::failed)?;
            Ok(json!({ "action": "exec.revoke", "command": command, "revoked": revoked }))
        }
        "exec.clear" => {
            services
                .exec_approvals
                .clear()
                .map_err(NodesError::failed)?;
            Ok(json!({ "action": "exec.clear", "cleared": true }))
        }
        "telegram.rejectPending" => {
            let rejected = services
                .channel_pairing
                .reject_pending_telegram()
                .await
                .map_err(NodesError::failed)?;
            Ok(json!({ "action": "telegram.rejectPending", "rejected": rejected }))
        }
        _ => Err(NodesError::bad("Unsupported action.")),
    }
}

/// `parseBooleanFlag` of the sessions route.
fn boolean_flag(uri: &Uri, key: &str, default: bool) -> bool {
    match query_param(uri, key) {
        None => default,
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
    }
}

/// `parseActiveMinutes`: `None` when absent, blank or not a number.
fn active_minutes(uri: &Uri) -> Option<i64> {
    let raw = query_param(uri, "activeMinutes")?;
    if raw.trim().is_empty() {
        return None;
    }
    js_parse_int(&raw).map(|minutes| minutes.clamp(1, 10_080))
}

/// `Date.parse(value)` for the ISO timestamps the store writes.
fn timestamp_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn is_unknown_session(session: &Conversation) -> bool {
    session
        .persona_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
}

fn includes_search_hit(session: &Conversation, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let needle = query.to_lowercase();
    [
        Some(session.id.as_str()),
        Some(session.title.as_str()),
        Some(session.channel_type.as_str()),
        session.external_chat_id.as_deref(),
        session.persona_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(&needle))
}

/// `GET /api/ops/sessions`
async fn sessions(
    State(state): State<SharedState>,
    peer: SocketPeer,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let user_id = match require_user(&headers) {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };
    let limit = clamped_int(&uri, "limit", 50, 1, 200);
    let query = query_param(&uri, "q")
        .unwrap_or_default()
        .trim()
        .to_string();
    let minutes = active_minutes(&uri);
    let include_global_requested = boolean_flag(&uri, "includeGlobal", false);
    let include_unknown = boolean_flag(&uri, "includeUnknown", true);
    // The global listing spans every user's conversations, so only the operator gets
    // it. `route.ts:81` applies `!authenticated` instead, which lets any caller without
    // a session read all users. Deliberate deviation, see `docs/RUST_MIGRATION.md`.
    let include_global_applied =
        include_global_requested && caller_is_admin(&state, &headers, &peer);

    let candidates = {
        let messages = state.messages.lock().await;
        let own = match messages.list_conversations(limit, Some(user_id.as_str())) {
            Ok(sessions) => sessions,
            Err(error) => {
                return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        };
        if !include_global_applied {
            own
        } else {
            let global = match messages.list_conversations(limit, None) {
                Ok(sessions) => sessions,
                Err(error) => {
                    return error_json(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                }
            };
            let mut merged: Vec<Conversation> = own;
            for session in global {
                if !merged.iter().any(|known| known.id == session.id) {
                    merged.push(session);
                }
            }
            merged
        }
    };

    let cutoff = minutes.map(|m| chrono::Utc::now().timestamp_millis() - m * 60_000);
    let mut sessions: Vec<Conversation> = candidates
        .into_iter()
        .filter(|session| includes_search_hit(session, &query))
        .filter(|session| include_unknown || !is_unknown_session(session))
        .filter(
            |session| match (cutoff, timestamp_ms(&session.updated_at)) {
                (Some(min), Some(updated)) => updated >= min,
                _ => true,
            },
        )
        .collect();
    sessions.sort_by(|left, right| {
        timestamp_ms(&right.updated_at)
            .unwrap_or(0)
            .cmp(&timestamp_ms(&left.updated_at).unwrap_or(0))
    });
    sessions.truncate(limit as usize);

    let session_values: Vec<Value> = sessions
        .iter()
        .filter_map(|session| serde_json::to_value(session).ok())
        .collect();
    Json(json!({
        "ok": true,
        "query": {
            "q": query,
            "limit": limit,
            "activeMinutes": minutes,
            "includeGlobalRequested": include_global_requested,
            "includeGlobalApplied": include_global_applied,
            "includeUnknown": include_unknown,
        },
        "sessions": session_values,
        "generatedAt": now_iso(),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use crate::families::ops_wire::test_support::{
        fake_services, scratch, send, state_in, state_with_mc_token, ScratchDir,
    };

    /// The operator's headers: the test user, with `MC_API_TOKEN` as the bearer token.
    const OPERATOR: [(&str, &str); 2] = [
        ("x-betaclaw-user-id", "user-a"),
        ("authorization", "Bearer admin-token"),
    ];

    async fn get_json(
        scratch: &ScratchDir,
        uri: &str,
        user: Option<&str>,
    ) -> (u16, serde_json::Value) {
        let state = state_in(scratch);
        let services = fake_services(scratch);
        let headers: Vec<(&str, &str)> = user
            .map(|u| ("x-betaclaw-user-id", u))
            .into_iter()
            .collect();
        let (status, body) = send(&state, &services, Method::GET, uri, &headers, None).await;
        (status.as_u16(), body)
    }

    #[tokio::test]
    async fn instances_without_user_is_unauthorized() {
        let scratch = scratch();
        let (status, body) = get_json(&scratch, "/api/ops/instances", None).await;
        assert_eq!(status, 401);
        assert_eq!(
            body,
            serde_json::json!({ "ok": false, "error": "Unauthorized" })
        );
    }

    #[tokio::test]
    async fn instances_reports_the_registry_counts() {
        let scratch = scratch();
        let (status, body) = get_json(&scratch, "/api/ops/instances?limit=0", Some("user-a")).await;
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        assert_eq!(body["instances"]["global"]["connectionCount"], 0);
        assert_eq!(
            body["instances"]["currentUser"]["connections"],
            serde_json::json!([])
        );
        assert!(body["instances"]["generatedAt"].is_string());
    }

    #[tokio::test]
    async fn nodes_without_user_is_unauthorized() {
        let scratch = scratch();
        let (status, body) = get_json(&scratch, "/api/ops/nodes", None).await;
        assert_eq!(status, 401);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn nodes_without_a_diagnostics_port_is_a_500() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services =
            crate::families::ops_wire::test_support::services_unwired_diagnostics(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/ops/nodes",
            &headers,
            None,
        )
        .await;
        assert_eq!(status, 500);
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().unwrap().contains("not wired"));
    }

    #[tokio::test]
    async fn nodes_post_exec_approval_round_trip() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let headers = OPERATOR;

        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/ops/nodes",
            &headers,
            Some(r#"{"action":"exec.approve","command":"ls -la"}"#),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["mutation"]["action"], "exec.approve");
        assert_eq!(body["nodes"]["execApprovals"]["total"], 1);
        assert_eq!(body["nodes"]["health"]["status"], "ok");
        assert_eq!(body["nodes"]["doctor"]["findings"], 0);

        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/ops/nodes",
            &headers,
            Some(r#"{"action":"exec.revoke","command":"ls -la"}"#),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["mutation"]["revoked"], true);
        assert_eq!(body["nodes"]["execApprovals"]["total"], 0);
    }

    #[tokio::test]
    async fn exec_approval_is_forbidden_without_the_admin() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let body = r#"{"action":"exec.approve","command":"ls -la"}"#;
        let no_admin: [(&str, &str); 1] = [("x-betaclaw-user-id", "user-a")];
        let wrong_token: [(&str, &str); 2] = [
            ("x-betaclaw-user-id", "user-a"),
            ("authorization", "Bearer wrong"),
        ];
        for headers in [&no_admin[..], &wrong_token[..]] {
            let (status, response) = send(
                &state,
                &services,
                Method::POST,
                "/api/ops/nodes",
                headers,
                Some(body),
            )
            .await;
            assert_eq!(status, 403);
            assert_eq!(
                response,
                serde_json::json!({ "ok": false, "error": "Forbidden" })
            );
        }
        assert!(services.exec_approvals.list().is_empty());
    }

    #[tokio::test]
    async fn exec_approvals_are_listed_only_for_the_admin() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let (status, _) = send(
            &state,
            &services,
            Method::POST,
            "/api/ops/nodes",
            &OPERATOR,
            Some(r#"{"action":"exec.approve","command":"ls -la"}"#),
        )
        .await;
        assert_eq!(status, 200);

        let user_only = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/ops/nodes",
            &user_only,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            body["nodes"]["execApprovals"],
            serde_json::json!({ "total": 0, "items": [] })
        );

        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/ops/nodes",
            &OPERATOR,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["nodes"]["execApprovals"]["total"], 1);
    }

    #[tokio::test]
    async fn nodes_post_rejects_bad_actions_with_400() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let headers = OPERATOR;
        let cases = [
            (r#"{}"#, "action must be a string."),
            (r#"{"action":"nope"}"#, "Unsupported action."),
            (
                r#"{"action":"channels.connect","channel":"webchat"}"#,
                "Unsupported channel for pairing.",
            ),
            (
                r#"{"action":"channels.rotateSecret","channel":"telegram"}"#,
                "Secret rotation is only supported for bridge channels.",
            ),
            (
                r#"{"action":"bindings.setPersona","channel":"nope"}"#,
                "Unsupported channel.",
            ),
        ];
        for (body, message) in cases {
            let (status, response) = send(
                &state,
                &services,
                Method::POST,
                "/api/ops/nodes",
                &headers,
                Some(body),
            )
            .await;
            assert_eq!(status, 400, "body {body}");
            assert_eq!(response["error"], message, "body {body}");
        }
    }

    #[tokio::test]
    async fn nodes_post_pairing_without_a_port_is_a_500() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/ops/nodes",
            &OPERATOR,
            Some(r#"{"action":"telegram.rejectPending"}"#),
        )
        .await;
        assert_eq!(status, 500);
        assert!(body["error"].as_str().unwrap().contains("not wired"));
    }

    #[tokio::test]
    async fn nodes_post_pairing_is_refused_without_the_operator() {
        let scratch = scratch();
        let state = state_in(&scratch);
        let services = crate::families::ops_wire::test_support::with_fake_diagnostics(&scratch);
        let headers = [("x-betaclaw-user-id", "user-a")];
        let (status, body) = send(
            &state,
            &services,
            Method::POST,
            "/api/ops/nodes",
            &headers,
            Some(r#"{"action":"telegram.rejectPending"}"#),
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(body["error"], "Forbidden");
    }

    #[tokio::test]
    async fn sessions_without_user_is_unauthorized() {
        let scratch = scratch();
        let (status, body) = get_json(&scratch, "/api/ops/sessions", None).await;
        assert_eq!(status, 401);
        assert_eq!(body["error"], "Unauthorized");
    }

    #[tokio::test]
    async fn sessions_echoes_the_clamped_query() {
        let scratch = scratch();
        let (status, body) = get_json(
            &scratch,
            "/api/ops/sessions?q=%20abc%20&limit=500&activeMinutes=0&includeUnknown=no",
            Some("user-a"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["query"]["q"], "abc");
        assert_eq!(body["query"]["limit"], 200);
        assert_eq!(body["query"]["activeMinutes"], 1);
        assert_eq!(body["query"]["includeUnknown"], false);
        assert_eq!(body["query"]["includeGlobalRequested"], false);
        assert_eq!(body["query"]["includeGlobalApplied"], false);
        assert_eq!(body["sessions"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn sessions_refuse_the_global_listing_without_operator() {
        let scratch = scratch();
        let (status, body) = get_json(
            &scratch,
            "/api/ops/sessions?includeGlobal=true",
            Some("user-a"),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["query"]["includeGlobalRequested"], true);
        assert_eq!(body["query"]["includeGlobalApplied"], false);
    }

    #[tokio::test]
    async fn sessions_apply_the_global_listing_for_the_operator() {
        let scratch = scratch();
        let state = state_with_mc_token(&scratch, "admin-token");
        let services = fake_services(&scratch);
        let (status, body) = send(
            &state,
            &services,
            Method::GET,
            "/api/ops/sessions?includeGlobal=true",
            &OPERATOR,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["query"]["includeGlobalApplied"], true);
    }
}
