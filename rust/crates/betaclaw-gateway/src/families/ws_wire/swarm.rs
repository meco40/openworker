//! Port of `src/server/gateway/methods/agent-v2/registerSwarmMethods.ts` (Agent
//! Room) with the swarm helpers of `agent-v2/helpers.ts`.
//!
//! Each handler validates the request in the TypeScript order, calls the
//! [`SwarmStore`] and the message ports, and broadcasts `agent.room.swarm`. Errors
//! carry the codes `AgentV2Error` used: INVALID_REQUEST, NOT_FOUND and UNAVAILABLE.
//!
//! `utf16_prefix` note: `artifact.slice(0, 8000)` counts UTF-16 units in
//! JavaScript. A surrogate pair that would be cut is dropped here, where JavaScript
//! would keep a lone surrogate.

use betaclaw_core::channels::ws::helpers::{
    ensure_persona_exists, js_number, js_truthy, now_iso, optional_bounded_string, optional_string,
    required_bounded_string, required_string, HandlerError, MAX_TASK_CHARS, MAX_TITLE_CHARS,
};
use betaclaw_core::gateway::events::AGENT_ROOM_SWARM;
use betaclaw_core::gateway::protocol::ErrorCode;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::{WsCall, WsServices};

/// `ChannelType.AGENT_ROOM` in `src/shared/domain/types.ts`.
const AGENT_ROOM_CHANNEL: &str = "AgentRoom";
/// `MAX_UNITS` in `agent-v2/helpers.ts`.
const MAX_UNITS: usize = 12;
/// `MAX_UNITS_JSON_CHARS` in `agent-v2/helpers.ts`.
const MAX_UNITS_JSON_CHARS: usize = 16_000;
/// The artifact prefix that `swarm.chain` copies into the new task.
const CHAIN_CONTEXT_CHARS: usize = 8_000;
const SWARM_STATUSES: [&str; 6] = ["idle", "running", "hold", "completed", "aborted", "error"];
const SWARM_PHASES: [&str; 6] = [
    "analysis",
    "research",
    "ideation",
    "critique",
    "best_case",
    "result",
];
const RESUMABLE_STATUSES: [&str; 4] = ["idle", "error", "aborted", "hold"];

/// `swarm.create`: creates a swarm in a new Agent Room conversation, or in an
/// existing one that is dedicated to Agent Room.
pub fn swarm_create(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let params = &call.params;
    let user = call.user_id();

    let title = required_bounded_string(params, "title", MAX_TITLE_CHARS)?;
    let task = required_bounded_string(params, "task", MAX_TASK_CHARS)?;
    let lead = required_string(params, "leadPersonaId")?;
    let units = parse_units(params, "units")?;
    let participants = distinct_persona_ids(&units);
    if !participants.contains(&lead) {
        return Err(HandlerError::invalid(
            "Lead persona must be included in units.",
        ));
    }
    if participants.len() < 2 {
        return Err(HandlerError::invalid(
            "Agent Room requires at least two distinct personas for swarm dialogue.",
        ));
    }
    ensure_persona_exists(&*s.personas, &lead, user)?;
    for unit in &units {
        ensure_persona_exists(&*s.personas, persona_of(unit), user)?;
    }

    let conversation_id = match optional_string(params, "conversationId") {
        Some(requested) => {
            let conversation = s
                .messages
                .get_conversation(&requested, user)?
                .ok_or_else(|| HandlerError::new(ErrorCode::NotFound, "Conversation not found."))?;
            if !s.swarms.is_agent_room_conversation(&requested, user)? {
                return Err(HandlerError::invalid(
                    "Conversation must be dedicated to Agent Room sessions.",
                ));
            }
            conversation.id
        }
        None => new_agent_room_conversation(s, &title, user)?,
    };
    s.messages.set_persona_id(&conversation_id, &lead, user)?;

    let swarm = s.swarms.create(json!({
        "conversationId": conversation_id,
        "userId": user,
        "title": title,
        "task": task,
        "leadPersonaId": lead,
        "units": units,
        "currentPhase": "analysis",
        "status": "idle",
        "consensusScore": 0,
        "holdFlag": false,
        "artifact": "",
        "artifactHistory": [],
        "friction": default_friction(),
        "lastSeq": 0,
        "searchEnabled": js_truthy(params.get("searchEnabled")),
        "swarmTemplate": optional_string(params, "swarmTemplate"),
        "pauseBetweenPhases": js_truthy(params.get("pauseBetweenPhases")),
    }))?;
    broadcast_swarm(s, user, &swarm, "created");
    Ok(json!({ "swarm": swarm }))
}

/// `swarm.list`: the caller's swarms, at most `limit` (default 100, at least 1).
pub fn swarm_list(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let raw = js_number(call.params.get("limit"));
    let limit = if raw.is_finite() {
        raw.floor().max(1.0) as u64
    } else {
        100
    };
    let swarms = s.swarms.list(call.user_id(), limit)?;
    Ok(json!({ "swarms": swarms }))
}

/// `swarm.get`.
pub fn swarm_get(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let id = required_string(&call.params, "id")?;
    let swarm = s
        .swarms
        .get(&id, call.user_id())?
        .ok_or_else(|| not_found("Swarm not found."))?;
    Ok(json!({ "swarm": swarm }))
}

/// `swarm.update`: changes the listed fields. Orchestrator-owned fields are refused.
pub fn swarm_update(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let params = &call.params;
    let user = call.user_id();
    let id = required_string(params, "id")?;

    for field in ["artifact", "artifactHistory", "friction"] {
        if params.get(field).is_some() {
            return Err(HandlerError::invalid(format!(
                "'{field}' is managed by the orchestrator and cannot be set via swarm.update."
            )));
        }
    }

    let mut patch = Map::new();
    if let Some(session_id) = optional_string(params, "sessionId") {
        patch.insert("sessionId".into(), json!(session_id));
    }
    if let Some(title) = optional_bounded_string(params, "title", MAX_TITLE_CHARS)? {
        patch.insert("title".into(), json!(title));
    }
    if let Some(task) = optional_bounded_string(params, "task", MAX_TASK_CHARS)? {
        patch.insert("task".into(), json!(task));
    }
    if let Some(lead) = optional_string(params, "leadPersonaId") {
        ensure_persona_exists(&*s.personas, &lead, user)?;
        patch.insert("leadPersonaId".into(), json!(lead));
    }
    if params.get("units").is_some() {
        let units = parse_units(params, "units")?;
        for unit in &units {
            ensure_persona_exists(&*s.personas, persona_of(unit), user)?;
        }
        patch.insert("units".into(), Value::Array(units));
    }
    if let Some(status) = optional_string(params, "status") {
        if !SWARM_STATUSES.contains(&status.as_str()) {
            return Err(HandlerError::invalid("Invalid swarm status."));
        }
        patch.insert("status".into(), json!(status));
    }
    if let Some(phase) = optional_string(params, "currentPhase") {
        if !SWARM_PHASES.contains(&phase.as_str()) {
            return Err(HandlerError::invalid("Invalid swarm phase."));
        }
        patch.insert("currentPhase".into(), json!(phase));
    }
    if params.get("consensusScore").is_some() {
        let score = js_number(params.get("consensusScore"));
        if !score.is_finite() || !(0.0..=100.0).contains(&score) {
            return Err(HandlerError::invalid(
                "consensusScore must be between 0 and 100.",
            ));
        }
        patch.insert("consensusScore".into(), json!(score));
    }
    if params.get("holdFlag").is_some() {
        patch.insert("holdFlag".into(), json!(js_truthy(params.get("holdFlag"))));
    }
    if params.get("searchEnabled").is_some() {
        patch.insert(
            "searchEnabled".into(),
            json!(js_truthy(params.get("searchEnabled"))),
        );
    }
    if params.get("swarmTemplate").is_some() {
        patch.insert(
            "swarmTemplate".into(),
            json!(optional_string(params, "swarmTemplate")),
        );
    }
    if params.get("pauseBetweenPhases").is_some() {
        patch.insert(
            "pauseBetweenPhases".into(),
            json!(js_truthy(params.get("pauseBetweenPhases"))),
        );
    }
    if let Some(speaker) = optional_string(params, "speakerOverride") {
        ensure_persona_exists(&*s.personas, &speaker, user)?;
        if let Some(existing) = s.swarms.get(&id, user)? {
            // Keeps the other buffer entries and replaces any earlier speaker override.
            let mut buffer: Vec<Value> = existing
                .get("phaseBuffer")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter(|entry| {
                            entry.get("type").and_then(Value::as_str) != Some("speakerOverride")
                        })
                        .cloned()
                        .collect::<Vec<Value>>()
                })
                .unwrap_or_default();
            buffer.push(json!({ "type": "speakerOverride", "personaId": speaker }));
            patch.insert("phaseBuffer".into(), Value::Array(buffer));
        }
    }
    if params.get("lastSeq").is_some() {
        let last_seq = js_number(params.get("lastSeq"));
        if !last_seq.is_finite() || last_seq < 0.0 {
            return Err(HandlerError::invalid(
                "lastSeq must be a non-negative number.",
            ));
        }
        patch.insert("lastSeq".into(), json!(last_seq.floor() as u64));
    }

    let updated = s
        .swarms
        .update(&id, user, patch)?
        .ok_or_else(|| not_found("Swarm not found."))?;
    broadcast_swarm(s, user, &updated, "updated");
    Ok(json!({ "swarm": updated }))
}

/// `swarm.delete`. Broadcasts `deleted` only after a real deletion.
pub fn swarm_delete(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let user = call.user_id();
    let id = required_string(&call.params, "id")?;
    if !s.swarms.delete(&id, user)? {
        return Err(not_found("Swarm not found."));
    }
    s.events.broadcast_to_user(
        user,
        AGENT_ROOM_SWARM,
        json!({ "swarmId": id, "status": "deleted", "updatedAt": now_iso() }),
    );
    Ok(json!({ "deleted": true }))
}

/// `swarm.fork`: copies a swarm into a new conversation, with a new title.
pub fn swarm_fork(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let user = call.user_id();
    let source_id = required_string(&call.params, "id")?;
    let source = s
        .swarms
        .get(&source_id, user)?
        .ok_or_else(|| not_found("Source swarm not found."))?;

    let fork_title = optional_bounded_string(&call.params, "title", MAX_TITLE_CHARS)?
        .unwrap_or_else(|| format!("{} (Fork)", field_text(&source, "title")));
    let conversation_id = new_agent_room_conversation(s, &fork_title, user)?;
    let lead = field_text(&source, "leadPersonaId");
    s.messages.set_persona_id(&conversation_id, &lead, user)?;

    let forked = s.swarms.create(json!({
        "conversationId": conversation_id,
        "userId": user,
        "title": fork_title,
        "task": source["task"],
        "leadPersonaId": lead,
        "units": copy_units(&source),
        "currentPhase": source["currentPhase"],
        "status": "idle",
        "consensusScore": 0,
        "holdFlag": false,
        "artifact": source["artifact"],
        "artifactHistory": source["artifactHistory"],
        "friction": default_friction(),
        "lastSeq": 0,
        "searchEnabled": source["searchEnabled"],
        "swarmTemplate": source["swarmTemplate"],
        "pauseBetweenPhases": source["pauseBetweenPhases"],
    }))?;
    broadcast_swarm(s, user, &forked, "created");
    Ok(json!({ "swarm": forked, "forkedFrom": source_id }))
}

/// `swarm.chain`: starts a new swarm whose task includes the source artifact.
pub fn swarm_chain(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let params = &call.params;
    let user = call.user_id();
    let source_id = required_string(params, "sourceSwarmId")?;
    let source = s
        .swarms
        .get(&source_id, user)?
        .ok_or_else(|| not_found("Source swarm not found."))?;

    let new_task = required_bounded_string(params, "task", MAX_TASK_CHARS)?;
    let source_title = field_text(&source, "title");
    let chain_title = optional_bounded_string(params, "title", MAX_TITLE_CHARS)?
        .unwrap_or_else(|| format!("{source_title} → Chain"));
    let artifact = field_text(&source, "artifact");
    let context_block = if artifact.is_empty() {
        String::new()
    } else {
        let context = utf16_prefix(&artifact, CHAIN_CONTEXT_CHARS);
        format!(
            "\n\n--- Context from previous swarm \"{source_title}\" ---\n{context}\n--- End context ---\n"
        )
    };
    let full_task = format!("{new_task}{context_block}");

    let (units, lead) = if params.get("units").is_some() {
        let units = parse_units(params, "units")?;
        let lead = required_string(params, "leadPersonaId")?;
        for unit in &units {
            ensure_persona_exists(&*s.personas, persona_of(unit), user)?;
        }
        (units, lead)
    } else {
        (copy_units(&source), field_text(&source, "leadPersonaId"))
    };
    ensure_persona_exists(&*s.personas, &lead, user)?;

    let conversation_id = new_agent_room_conversation(s, &chain_title, user)?;
    s.messages.set_persona_id(&conversation_id, &lead, user)?;

    let chained = s.swarms.create(json!({
        "conversationId": conversation_id,
        "userId": user,
        "title": chain_title,
        "task": full_task,
        "leadPersonaId": lead,
        "units": units,
        "currentPhase": "analysis",
        "status": "idle",
        "consensusScore": 0,
        "holdFlag": false,
        "artifact": "",
        "artifactHistory": [],
        "friction": default_friction(),
        "lastSeq": 0,
        "searchEnabled": source["searchEnabled"],
        "swarmTemplate": source["swarmTemplate"],
        "pauseBetweenPhases": source["pauseBetweenPhases"],
    }))?;
    broadcast_swarm(s, user, &chained, "created");
    Ok(json!({ "swarm": chained, "chainedFrom": source_id }))
}

/// `swarm.deploy`: starts a swarm that is idle, errored, aborted or on hold.
pub fn swarm_deploy(s: &WsServices, call: &WsCall) -> Result<Value, HandlerError> {
    ensure_enabled()?;
    let user = call.user_id();
    let id = required_string(&call.params, "id")?;
    let swarm = s
        .swarms
        .get(&id, user)?
        .ok_or_else(|| not_found("Swarm not found."))?;

    let status = swarm
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    if !RESUMABLE_STATUSES.contains(&status) {
        let allowed = RESUMABLE_STATUSES.join(", ");
        return Err(HandlerError::invalid(format!(
            "Cannot deploy swarm in status '{status}'. Must be one of: {allowed}."
        )));
    }

    let mut patch = Map::new();
    patch.insert("status".into(), json!("running"));
    patch.insert("holdFlag".into(), json!(false));
    patch.insert("currentDeployCommandId".into(), Value::Null);
    if status != "hold" {
        patch.insert("currentPhase".into(), json!("analysis"));
        patch.insert("lastSeq".into(), json!(0));
    }

    let updated = s
        .swarms
        .update(&id, user, patch)?
        .ok_or_else(|| not_found("Swarm not found."))?;
    s.events.broadcast_to_user(
        user,
        AGENT_ROOM_SWARM,
        json!({ "swarmId": id, "status": "updated", "swarm": updated, "updatedAt": now_iso() }),
    );
    Ok(json!({ "swarm": updated }))
}

/// `assertAgentRoomEnabled()`. The env value is read on each call, as in TypeScript.
fn ensure_enabled() -> Result<(), HandlerError> {
    if agent_room_enabled(std::env::var("AGENT_ROOM_ENABLED").ok().as_deref()) {
        Ok(())
    } else {
        Err(HandlerError::new(
            ErrorCode::Unavailable,
            "Agent Room is disabled by server configuration.",
        ))
    }
}

/// `String(raw || 'true').toLowerCase() === 'true'`.
fn agent_room_enabled(raw: Option<&str>) -> bool {
    raw.filter(|value| !value.is_empty())
        .unwrap_or("true")
        .to_lowercase()
        == "true"
}

/// `parseUnits`: the valid `{personaId, role}` entries, trimmed, with the size limits.
fn parse_units(params: &Value, key: &str) -> Result<Vec<Value>, HandlerError> {
    let Some(items) = params.get(key).and_then(Value::as_array) else {
        return Err(HandlerError::invalid(format!("{key} must be an array")));
    };
    let units: Vec<Value> = items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let persona_id = text_field(object.get("personaId"));
            let role = text_field(object.get("role"));
            (!persona_id.is_empty() && !role.is_empty())
                .then(|| json!({ "personaId": persona_id, "role": role }))
        })
        .collect();

    if units.is_empty() {
        return Err(HandlerError::invalid(format!(
            "{key} must contain at least one valid unit"
        )));
    }
    if units.len() > MAX_UNITS {
        return Err(HandlerError::invalid(format!(
            "Too many swarm units (max {MAX_UNITS})."
        )));
    }
    let serialized = serde_json::to_string(&units).unwrap_or_default();
    if serialized.encode_utf16().count() > MAX_UNITS_JSON_CHARS {
        return Err(HandlerError::invalid("Units payload too large."));
    }
    Ok(units)
}

/// `String(value || '').trim()` for a JSON value.
fn text_field(value: Option<&Value>) -> String {
    betaclaw_core::channels::ws::helpers::js_string_or(value, "")
        .trim()
        .to_string()
}

/// `distinctPersonaIds`: unique persona ids in first-seen order.
fn distinct_persona_ids(units: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for unit in units {
        let id = persona_of(unit).to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn persona_of(unit: &Value) -> &str {
    unit.get("personaId").and_then(Value::as_str).unwrap_or("")
}

/// The `{personaId, role}` pairs of a stored swarm, as `swarm.fork` and `swarm.chain`
/// copy them.
fn copy_units(swarm: &Value) -> Vec<Value> {
    swarm
        .get("units")
        .and_then(Value::as_array)
        .map(|units| {
            units
                .iter()
                .map(|unit| json!({ "personaId": unit["personaId"], "role": unit["role"] }))
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default()
}

/// Creates the Agent Room conversation for a new swarm.
fn new_agent_room_conversation(
    s: &WsServices,
    title: &str,
    user: &str,
) -> Result<String, HandlerError> {
    let external_id = format!("agent-room-{}", Uuid::new_v4());
    let conversation = s.messages.get_or_create_conversation(
        AGENT_ROOM_CHANNEL,
        &external_id,
        Some(title),
        user,
    )?;
    Ok(conversation.id)
}

fn default_friction() -> Value {
    json!({
        "level": "low",
        "confidence": 0,
        "hold": false,
        "reasons": [],
        "updatedAt": now_iso(),
    })
}

fn broadcast_swarm(s: &WsServices, user: &str, swarm: &Value, status: &str) {
    s.events.broadcast_to_user(
        user,
        AGENT_ROOM_SWARM,
        json!({
            "swarmId": swarm["id"],
            "status": status,
            "swarm": swarm,
            "updatedAt": swarm["updatedAt"],
        }),
    );
}

/// A string field of a stored swarm, or `""` when it is missing.
fn field_text(swarm: &Value, key: &str) -> String {
    swarm
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn not_found(message: &str) -> HandlerError {
    HandlerError::new(ErrorCode::NotFound, message)
}

/// The first `max_units` UTF-16 units of `text`, as `text.slice(0, max_units)`.
fn utf16_prefix(text: &str, max_units: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if used + width > max_units {
            break;
        }
        used += width;
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use betaclaw_core::channels::ws::helpers::HandlerError;
    use betaclaw_core::gateway::events::AGENT_ROOM_SWARM;
    use betaclaw_core::gateway::protocol::ErrorCode;
    use serde_json::json;

    use super::super::test_support::{failure, fixture, invoke, payload, test_client, Fake};
    use super::*;

    fn seed_source(fake: &Fake) {
        fake.seed_swarm(json!({
            "id": "sw-src",
            "userId": "u1",
            "title": "Alpha",
            "task": "Plan it",
            "leadPersonaId": "p1",
            "units": [
                {"personaId": "p1", "role": "lead"},
                {"personaId": "p2", "role": "critic"},
            ],
            "currentPhase": "critique",
            "status": "idle",
            "artifact": "draft",
            "artifactHistory": ["v1"],
            "searchEnabled": true,
            "swarmTemplate": "tpl",
            "pauseBetweenPhases": false,
            "phaseBuffer": [{"type": "speakerOverride", "personaId": "p2"}],
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }));
    }

    #[test]
    fn agent_room_flag_is_on_unless_disabled() {
        assert!(agent_room_enabled(None));
        assert!(agent_room_enabled(Some("")));
        assert!(!agent_room_enabled(Some("false")));
    }

    #[test]
    fn utf16_prefix_does_not_split_a_surrogate_pair() {
        assert_eq!(utf16_prefix("ab\u{1F600}", 3), "ab");
        assert_eq!(utf16_prefix("ab\u{1F600}", 4), "ab\u{1F600}");
    }

    #[tokio::test]
    async fn swarm_create_stores_the_swarm_and_announces_it() {
        let (fake, services) = fixture();
        fake.seed_personas(&["p1", "p2"]);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.create",
                json!({
                    "title": "T",
                    "task": "Do it",
                    "leadPersonaId": "p1",
                    "units": [
                        {"personaId": "p1", "role": "lead"},
                        {"personaId": "p2", "role": "critic"},
                    ],
                }),
                &client,
            )
            .await,
        );
        assert_eq!(body["swarm"]["id"], "sw-1");
        assert_eq!(body["swarm"]["status"], "idle");
        assert_eq!(fake.state.lock().unwrap().events[0].0, AGENT_ROOM_SWARM);

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.create",
                json!({
                    "title": "T",
                    "task": "Do it",
                    "leadPersonaId": "p1",
                    "units": [
                        {"personaId": "p2", "role": "critic"},
                        {"personaId": "p3", "role": "x"},
                    ],
                }),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::invalid("Lead persona must be included in units.")
        );
    }

    #[tokio::test]
    async fn swarm_list_returns_the_callers_swarms_and_passes_store_errors() {
        let (fake, services) = fixture();
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.list",
                json!({"limit": "5"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["swarms"].as_array().unwrap().len(), 1);

        fake.state.lock().unwrap().fail = Some(HandlerError::plain("boom"));
        let err = failure(invoke(&services, "agent.v2.swarm.list", json!({}), &client).await);
        assert_eq!(err, HandlerError::plain("boom"));
    }

    #[tokio::test]
    async fn swarm_get_returns_the_swarm_or_not_found() {
        let (fake, services) = fixture();
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.get",
                json!({"id": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["swarm"]["title"], "Alpha");

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.get",
                json!({"id": "nope"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::new(ErrorCode::NotFound, "Swarm not found.")
        );
    }

    #[tokio::test]
    async fn swarm_update_applies_the_patch_and_refuses_orchestrator_fields() {
        let (fake, services) = fixture();
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.update",
                json!({"id": "sw-src", "title": "Beta", "consensusScore": "42", "status": "running"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["swarm"]["title"], "Beta");
        assert_eq!(body["swarm"]["status"], "running");
        assert_eq!(body["swarm"]["consensusScore"], 42.0);

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.update",
                json!({"id": "sw-src", "artifact": "x"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::invalid(
                "'artifact' is managed by the orchestrator and cannot be set via swarm.update."
            )
        );
    }

    #[tokio::test]
    async fn swarm_delete_removes_the_swarm_and_reports_missing_ids() {
        let (fake, services) = fixture();
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.delete",
                json!({"id": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(body, json!({"deleted": true}));
        assert_eq!(fake.state.lock().unwrap().events[0].0, AGENT_ROOM_SWARM);

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.delete",
                json!({"id": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::new(ErrorCode::NotFound, "Swarm not found.")
        );
    }

    #[tokio::test]
    async fn swarm_fork_copies_the_source_into_a_new_conversation() {
        let (fake, services) = fixture();
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.fork",
                json!({"id": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["forkedFrom"], "sw-src");
        assert_eq!(body["swarm"]["title"], "Alpha (Fork)");
        assert_eq!(body["swarm"]["artifact"], "draft");

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.fork",
                json!({"id": "nope"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::new(ErrorCode::NotFound, "Source swarm not found.")
        );
    }

    #[tokio::test]
    async fn swarm_chain_carries_the_source_artifact_into_the_task() {
        let (fake, services) = fixture();
        fake.seed_personas(&["p1", "p2"]);
        seed_source(&fake);
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.chain",
                json!({"sourceSwarmId": "sw-src", "task": "Next"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["chainedFrom"], "sw-src");
        assert_eq!(body["swarm"]["title"], "Alpha → Chain");
        let task = body["swarm"]["task"].as_str().unwrap();
        assert!(task.starts_with("Next"));
        assert!(task.contains("--- Context from previous swarm \"Alpha\""));
        assert!(task.contains("draft"));

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.chain",
                json!({"sourceSwarmId": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(err, HandlerError::invalid("task is required"));
    }

    #[tokio::test]
    async fn swarm_deploy_starts_a_resumable_swarm_and_refuses_a_running_one() {
        let (fake, services) = fixture();
        seed_source(&fake);
        fake.seed_swarm(json!({
            "id": "sw-busy",
            "userId": "u1",
            "title": "Busy",
            "status": "running",
        }));
        let (client, _rx) = test_client();
        let body = payload(
            invoke(
                &services,
                "agent.v2.swarm.deploy",
                json!({"id": "sw-src"}),
                &client,
            )
            .await,
        );
        assert_eq!(body["swarm"]["status"], "running");
        assert_eq!(body["swarm"]["currentPhase"], "analysis");

        let err = failure(
            invoke(
                &services,
                "agent.v2.swarm.deploy",
                json!({"id": "sw-busy"}),
                &client,
            )
            .await,
        );
        assert_eq!(
            err,
            HandlerError::invalid(
                "Cannot deploy swarm in status 'running'. Must be one of: idle, error, aborted, hold."
            )
        );
    }
}
