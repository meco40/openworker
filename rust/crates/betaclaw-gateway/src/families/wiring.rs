//! Production implementations of the ports that cross family borders.
//!
//! The families reach the gateway state only through traits. This module supplies
//! the implementations the process runs with. A port whose owning slice is not
//! wired yet answers UNAVAILABLE through [`Unwired`], so a client gets a typed
//! error instead of a hang.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use betaclaw_core::agent_v2::errors::AgentV2Error;
use betaclaw_core::agent_v2::session::commands::enqueue::{
    abort_command, approval_command, enqueue_command, follow_up_command, input_command,
    steer_command,
};
use betaclaw_core::agent_v2::session::events::replay::replay_session_events;
use betaclaw_core::agent_v2::session::state::update::{
    get_session as get_agent_v2_session, list_sessions as list_agent_v2_sessions,
};
use betaclaw_core::agent_v2::session::utils::{
    build_approval_result_message, ApprovalResultStatus,
};
use betaclaw_core::agent_v2::types::{
    AppendEventInput, CommandStatus, CommandType, CompleteCommandInput, CreateSessionInput,
    EventEnvelope, EventType, JsonObject, ReplayEventsInput, SessionStatus,
};
use betaclaw_core::channels::messages::service::execution::ports::StreamSink;
use betaclaw_core::channels::pairing::bridge_accounts::{
    list_bridge_accounts as list_bridge_account_summaries, BridgeAccountSummary, BridgeChannel,
};
use betaclaw_core::channels::pairing::credentials::ChannelCredentialStore;
use betaclaw_core::channels::pairing::PairChannelType;
use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::channels::ws::ports::{
    AgentV2Sessions, BoxFuture, ChannelBinding, ChannelBindingWrite, ChannelPairing, CommandResult,
    ConversationView, EventSink, IncomingAttachment, MessageService, MessageStore, PersonaRecord,
    PersonaStore, ReplayRequest, SessionCommand, SessionCommandKind, StartSession, StartedSession,
    ToolApproval, WebUiMessage, WebUiResult,
};
use betaclaw_core::gateway::broadcast::broadcast_to_user as broadcast;
use betaclaw_core::gateway::protocol::ErrorCode;
use betaclaw_core::messages_store::types::{
    AgentRoomSwarmPatch, AgentRoomSwarmPhase, AgentRoomSwarmStatus, CreateAgentRoomSwarmInput,
    PhaseBufferEntry, SwarmFriction, SwarmUnit,
};
use betaclaw_core::messages_store::{InboxListInput, InboxListResult, MessagesStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::channels_wire::Services as ChannelServices;
use super::master::automation::AutomationRuntimePort;
use super::master::skills::{SkillDispatcher, SkillFuture, SkillInvocation};
use super::ws_wire::ports::{InboxRateLimit, InboxStore, SwarmStore};
use super::ws_wire::WsServices;
use crate::routes::inbox::RateDecision;
use crate::state::SharedState;
use betaclaw_core::automation::types::{
    AutomationRule, CreateAutomationRuleInput, UpdateAutomationRuleInput,
};

/// Stands in for every port whose owning slice is not wired yet. Each call answers
/// UNAVAILABLE.
pub struct Unwired;

fn unwired(what: &str) -> HandlerError {
    HandlerError::new(
        ErrorCode::Unavailable,
        format!("{what} is not wired in the Rust gateway yet"),
    )
}

impl MessageService for Unwired {
    fn get_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<Option<ConversationView>, HandlerError> {
        Err(unwired("the message service"))
    }

    fn set_persona_id(
        &self,
        _conversation_id: &str,
        _persona_id: &str,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        Err(unwired("the message service"))
    }

    fn get_or_create_conversation(
        &self,
        _channel_type: &str,
        _external_id: &str,
        _title: Option<&str>,
        _user_id: &str,
    ) -> Result<ConversationView, HandlerError> {
        Err(unwired("the message service"))
    }

    fn delete_conversation(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<bool, HandlerError> {
        Err(unwired("the message service"))
    }

    fn set_model_override(
        &self,
        _conversation_id: &str,
        _model_override: Option<&str>,
        _user_id: &str,
    ) -> Result<(), HandlerError> {
        Err(unwired("the message service"))
    }

    fn abort_generation(&self, _conversation_id: &str) -> Result<bool, HandlerError> {
        Err(unwired("the message service"))
    }

    fn persist_incoming_attachment(
        &self,
        _attachment: IncomingAttachment,
    ) -> Result<Value, HandlerError> {
        Err(unwired("the message service"))
    }

    fn handle_web_ui_message(
        &self,
        _message: WebUiMessage,
        _on_delta: Option<StreamSink>,
    ) -> BoxFuture<'_, Result<WebUiResult, HandlerError>> {
        Box::pin(async { Err(unwired("the message service")) })
    }

    fn respond_tool_approval<'a>(
        &'a self,
        _approval: ToolApproval,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async { Err(unwired("the message service")) })
    }
}

impl MessageStore for Unwired {
    fn list_messages(
        &self,
        _conversation_id: &str,
        _limit: i64,
        _before: Option<&str>,
        _user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        Err(unwired("the message store"))
    }

    fn list_conversations(
        &self,
        _limit: usize,
        _user_id: &str,
    ) -> Result<Vec<Value>, HandlerError> {
        Err(unwired("the message store"))
    }

    fn list_channel_bindings(&self, _user_id: &str) -> Result<Vec<ChannelBinding>, HandlerError> {
        Err(unwired("the message store"))
    }

    fn upsert_channel_binding(&self, _binding: ChannelBindingWrite) -> Result<(), HandlerError> {
        Err(unwired("the message store"))
    }
}

impl PersonaStore for Unwired {
    fn find_persona(
        &self,
        _persona_id: &str,
        _user_id: &str,
    ) -> Result<Option<PersonaRecord>, HandlerError> {
        Err(unwired("the persona store"))
    }
}

impl ChannelPairing for Unwired {
    fn list_bridge_accounts(&self, _channel: &str) -> Result<Value, HandlerError> {
        Err(unwired("channel pairing"))
    }

    fn pair_channel<'a>(
        &'a self,
        _channel: &'a str,
        _token: &'a str,
        _account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async { Err(unwired("channel pairing")) })
    }

    fn unpair_channel<'a>(
        &'a self,
        _channel: &'a str,
        _account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HandlerError>> {
        Box::pin(async { Err(unwired("channel pairing")) })
    }
}

impl AgentV2Sessions for Unwired {
    fn get_command_result(&self, _: &str, _: &str, _: &str) -> Result<Option<Value>, HandlerError> {
        Err(unwired("the agent-v2 session manager"))
    }
    fn start_session<'a>(
        &'a self,
        _input: StartSession,
    ) -> BoxFuture<'a, Result<StartedSession, HandlerError>> {
        Box::pin(async { Err(unwired("the agent-v2 session manager")) })
    }

    fn enqueue<'a>(
        &'a self,
        _command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>> {
        Box::pin(async { Err(unwired("the agent-v2 session manager")) })
    }

    fn get_session(
        &self,
        _session_id: &str,
        _user_id: &str,
    ) -> Result<Option<Value>, HandlerError> {
        Err(unwired("the agent-v2 session manager"))
    }

    fn list_sessions(&self, _user_id: &str, _limit: u64) -> Result<Vec<Value>, HandlerError> {
        Err(unwired("the agent-v2 session manager"))
    }

    fn replay_events(&self, _request: ReplayRequest) -> Result<Vec<Value>, HandlerError> {
        Err(unwired("the agent-v2 session manager"))
    }
}

fn not_wired_text(what: &str) -> String {
    format!("{what} is not wired in the Rust gateway yet")
}

impl AutomationRuntimePort for Unwired {
    fn list_rules(&self, _user_id: &str) -> Result<Vec<AutomationRule>, String> {
        Err(not_wired_text("the automation runtime"))
    }

    fn create_rule(&self, _input: &CreateAutomationRuleInput) -> Result<AutomationRule, String> {
        Err(not_wired_text("the automation runtime"))
    }

    fn update_rule(
        &self,
        _rule_id: &str,
        _user_id: &str,
        _patch: &UpdateAutomationRuleInput,
    ) -> Result<Option<AutomationRule>, String> {
        Err(not_wired_text("the automation runtime"))
    }

    fn delete_rule(&self, _rule_id: &str, _user_id: &str) -> Result<bool, String> {
        Err(not_wired_text("the automation runtime"))
    }
}

impl SkillDispatcher for Unwired {
    fn dispatch<'a>(&'a self, _invocation: SkillInvocation<'a>) -> SkillFuture<'a> {
        Box::pin(async { Err(not_wired_text("skill dispatch")) })
    }
}

/// The message repository behind the swarm and inbox ports.
pub struct MessagesPorts(SharedState);

fn store_error(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::new(ErrorCode::Unavailable, error.to_string())
}

fn to_value<T: Serialize>(record: T) -> Result<Value, HandlerError> {
    serde_json::to_value(record).map_err(store_error)
}

impl MessagesPorts {
    /// The ports are synchronous, so the store is taken with `try_lock`. A busy store
    /// answers UNAVAILABLE instead of blocking the reactor.
    fn messages(&self) -> Result<tokio::sync::MutexGuard<'_, MessagesStore>, HandlerError> {
        self.0
            .messages
            .try_lock()
            .map_err(|_| HandlerError::new(ErrorCode::Unavailable, "The message store is busy."))
    }
}

/// `createAgentRoomSwarm` input, as the WS handler sends it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSwarm {
    conversation_id: String,
    user_id: String,
    title: String,
    task: String,
    lead_persona_id: String,
    #[serde(default)]
    units: Vec<SwarmUnit>,
    session_id: Option<String>,
    status: Option<AgentRoomSwarmStatus>,
    current_phase: Option<AgentRoomSwarmPhase>,
    consensus_score: Option<f64>,
    hold_flag: Option<bool>,
    artifact: Option<String>,
    #[serde(default)]
    artifact_history: Vec<String>,
    friction: Option<SwarmFriction>,
}

/// `updateAgentRoomSwarm` patch, as the WS handler sends it. A missing key leaves the
/// field alone. A `null` on a nullable field clears it, and the double `Option` keeps
/// that apart from "missing".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwarmPatch {
    #[serde(default, deserialize_with = "double_option")]
    session_id: Option<Option<String>>,
    title: Option<String>,
    task: Option<String>,
    lead_persona_id: Option<String>,
    units: Option<Vec<SwarmUnit>>,
    status: Option<AgentRoomSwarmStatus>,
    current_phase: Option<AgentRoomSwarmPhase>,
    consensus_score: Option<i64>,
    hold_flag: Option<bool>,
    artifact: Option<String>,
    artifact_history: Option<Vec<String>>,
    friction: Option<SwarmFriction>,
    last_seq: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    current_deploy_command_id: Option<Option<String>>,
    search_enabled: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    swarm_template: Option<Option<String>>,
    pause_between_phases: Option<bool>,
    phase_buffer: Option<Vec<PhaseBufferEntry>>,
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl SwarmStore for MessagesPorts {
    fn is_agent_room_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<bool, HandlerError> {
        self.messages()?
            .is_agent_room_conversation(conversation_id, Some(user_id))
            .map_err(store_error)
    }

    fn create(&self, input: Value) -> Result<Value, HandlerError> {
        let swarm: NewSwarm = serde_json::from_value(input)
            .map_err(|error| HandlerError::invalid(error.to_string()))?;
        let record = self
            .messages()?
            .create_agent_room_swarm(&CreateAgentRoomSwarmInput {
                conversation_id: &swarm.conversation_id,
                user_id: &swarm.user_id,
                title: &swarm.title,
                task: &swarm.task,
                lead_persona_id: &swarm.lead_persona_id,
                units: swarm.units,
                session_id: swarm.session_id.as_deref(),
                status: swarm.status,
                current_phase: swarm.current_phase,
                consensus_score: swarm.consensus_score,
                hold_flag: swarm.hold_flag,
                artifact: swarm.artifact.as_deref(),
                artifact_history: swarm.artifact_history,
                friction: swarm.friction,
                ..Default::default()
            })
            .map_err(store_error)?;
        to_value(record)
    }

    fn list(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        self.messages()?
            .list_agent_room_swarms(user_id, limit)
            .map_err(store_error)?
            .into_iter()
            .map(to_value)
            .collect()
    }

    fn get(&self, id: &str, user_id: &str) -> Result<Option<Value>, HandlerError> {
        let record = self
            .messages()?
            .get_agent_room_swarm(id, user_id)
            .map_err(store_error)?;
        record.map(to_value).transpose()
    }

    fn update(
        &self,
        id: &str,
        user_id: &str,
        patch: Map<String, Value>,
    ) -> Result<Option<Value>, HandlerError> {
        let patch: SwarmPatch = serde_json::from_value(Value::Object(patch))
            .map_err(|error| HandlerError::invalid(error.to_string()))?;
        let patch = AgentRoomSwarmPatch {
            session_id: patch.session_id,
            title: patch.title,
            task: patch.task,
            lead_persona_id: patch.lead_persona_id,
            units: patch.units,
            status: patch.status,
            current_phase: patch.current_phase,
            consensus_score: patch.consensus_score,
            hold_flag: patch.hold_flag,
            artifact: patch.artifact,
            artifact_history: patch.artifact_history,
            friction: patch.friction,
            last_seq: patch.last_seq,
            current_deploy_command_id: patch.current_deploy_command_id,
            search_enabled: patch.search_enabled,
            swarm_template: patch.swarm_template,
            pause_between_phases: patch.pause_between_phases,
            phase_buffer: patch.phase_buffer,
        };
        let record = self
            .messages()?
            .update_agent_room_swarm(id, user_id, &patch)
            .map_err(store_error)?;
        record.map(to_value).transpose()
    }

    fn delete(&self, id: &str, user_id: &str) -> Result<bool, HandlerError> {
        self.messages()?
            .delete_agent_room_swarm(id, user_id)
            .map_err(store_error)
    }
}

impl InboxStore for MessagesPorts {
    fn list_inbox(&self, input: InboxListInput<'_>) -> Result<InboxListResult, HandlerError> {
        self.messages()?.list_inbox(&input).map_err(store_error)
    }
}

/// Fixed one-minute inbox window. The transport prefix keeps the WS window apart from the
/// HTTP window of the same user.
pub struct InboxLimit(SharedState);

impl InboxRateLimit for InboxLimit {
    fn allow(&self, transport: &str, key: &str) -> bool {
        let limit = self.0.config.inbox_http_rate_limit_per_minute;
        let window = format!("{transport}:{key}");
        matches!(
            self.0
                .inbox_rate_limiter
                .consume(&window, limit, Instant::now()),
            RateDecision::Allowed
        )
    }
}

/// Sends an event to every connection of one user, as `broadcastToUser` does.
pub struct RegistryEvents(SharedState);

impl EventSink for RegistryEvents {
    fn broadcast_to_user(&self, user_id: &str, event: &str, payload: Value) {
        broadcast(&self.0.registry, user_id, event, Some(payload));
    }
}

/// The channel pairing flows as the WS `ChannelPairing` port. The channel family's
/// production `ChannelPairing` runs them; this adapter only shapes its result for the
/// handlers of `src/server/gateway/methods/channels.ts`.
pub struct ChannelsPairing(Arc<ChannelServices>);

/// The account object of `listBridgeAccounts`, with the keys of the TypeScript source.
fn account_json(account: &BridgeAccountSummary) -> Value {
    json!({
        "accountId": account.account_id,
        "pairingStatus": account.pairing_status,
        "peerName": account.peer_name,
        "lastSeenAt": account.last_seen_at,
        "allowFrom": account.allow_from,
    })
}

/// The bridge channels: WhatsApp and iMessage (`isBridgeChannel`).
fn bridge_channel(channel: &str) -> Result<BridgeChannel, HandlerError> {
    match channel {
        "whatsapp" => Ok(BridgeChannel::WhatsApp),
        "imessage" => Ok(BridgeChannel::IMessage),
        other => Err(HandlerError::plain(format!(
            "Unsupported bridge channel: {other}."
        ))),
    }
}

fn pair_channel_type(channel: &str) -> Result<PairChannelType, HandlerError> {
    PairChannelType::parse(channel)
        .ok_or_else(|| HandlerError::plain(format!("Unsupported channel: {channel}")))
}

impl ChannelPairing for ChannelsPairing {
    fn list_bridge_accounts(&self, channel: &str) -> Result<Value, HandlerError> {
        let channel = bridge_channel(channel)?;
        let store: &dyn ChannelCredentialStore = self.0.db.as_ref();
        let accounts = list_bridge_account_summaries(store, channel)
            .map_err(|error| HandlerError::plain(error.0))?;
        Ok(Value::Array(accounts.iter().map(account_json).collect()))
    }

    fn pair_channel<'a>(
        &'a self,
        channel: &'a str,
        token: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, HandlerError>> {
        Box::pin(async move {
            let kind = pair_channel_type(channel)?;
            let outcome = self
                .0
                .pairing
                .pair_channel(kind, token, account_id)
                .await
                .map_err(|error| HandlerError::plain(error.0))?;
            Ok(json!({
                "status": outcome.status,
                "transport": outcome.transport,
                "accountId": outcome.account_id,
                "peerName": outcome.peer_name,
                "details": outcome.details,
            }))
        })
    }

    fn unpair_channel<'a>(
        &'a self,
        channel: &'a str,
        account_id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), HandlerError>> {
        Box::pin(async move {
            let kind = pair_channel_type(channel)?;
            self.0
                .pairing
                .unpair_channel(kind, account_id)
                .await
                .map_err(|error| HandlerError::plain(error.0))
        })
    }
}

/// Production `AgentV2Sessions` port over `state.agent_v2` and the chat runtime
/// (`AgentV2SessionManager` in `src/server/agent-v2/session/index.ts`).
pub struct AgentV2SessionsPort(SharedState);

fn agent_v2_error(error: AgentV2Error) -> HandlerError {
    let code = ErrorCode::from_error_code(error.code().map(|code| code.as_str()));
    HandlerError::new(code, error.to_string())
}

fn emit_agent_v2_events(state: &SharedState, user_id: &str, events: &[EventEnvelope]) {
    for envelope in events {
        if let Ok(payload) = serde_json::to_value(envelope) {
            broadcast(
                &state.registry,
                user_id,
                envelope.event_type.as_str(),
                Some(payload),
            );
        }
    }
}

async fn process_agent_v2_queue(state: SharedState, session_id: String, user_id: String) {
    loop {
        let started = match state
            .agent_v2
            .start_next_queued_command(&session_id, &user_id)
        {
            Ok(Some(started)) => started,
            Ok(None) | Err(_) => break,
        };
        emit_agent_v2_events(&state, &user_id, &started.events);

        let conversation_id = started.session.conversation_id.clone();
        let mut completion_status = CommandStatus::Completed;
        let mut result_payload: Option<JsonObject> = None;
        let mut error_code: Option<String> = None;
        let mut error_message: Option<String> = None;

        match started.command.command_type {
            CommandType::Abort => {
                let aborted = state
                    .chat
                    .get()
                    .and_then(|chat| chat.ws_messages.abort_generation(&conversation_id).ok())
                    .unwrap_or(false);
                completion_status = CommandStatus::Aborted;
                let mut map = JsonObject::new();
                map.insert(
                    "message".into(),
                    json!(if aborted {
                        "Abort signal sent."
                    } else {
                        "No in-flight command to abort."
                    }),
                );
                map.insert("aborted".into(), json!(aborted));
                result_payload = Some(map);
            }
            CommandType::Approval => {
                let token = started
                    .command
                    .payload
                    .get("approvalToken")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if token.is_empty() {
                    completion_status = CommandStatus::FailedRecoverable;
                    error_code = Some("COMMAND_EXECUTION_FAILED".into());
                    error_message = Some("approvalToken is required.".into());
                    let mut map = JsonObject::new();
                    map.insert("message".into(), json!("approvalToken is required."));
                    result_payload = Some(map);
                } else if let Some(chat) = state.chat.get() {
                    let approved = started
                        .command
                        .payload
                        .get("approved")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let approve_always = started
                        .command
                        .payload
                        .get("approveAlways")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let tool_id = started
                        .command
                        .payload
                        .get("toolId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let tool_function_name = started
                        .command
                        .payload
                        .get("toolFunctionName")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    match chat
                        .ws_messages
                        .respond_tool_approval(ToolApproval {
                            conversation_id: conversation_id.clone(),
                            user_id: user_id.clone(),
                            approval_token: token.clone(),
                            approved,
                            approve_always,
                            tool_id,
                            tool_function_name,
                        })
                        .await
                    {
                        Ok(outcome) => {
                            let status_str = outcome
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("not_found");
                            let status_enum = match status_str {
                                "approved" => ApprovalResultStatus::Approved,
                                "denied" => ApprovalResultStatus::Denied,
                                "approval_required" => ApprovalResultStatus::ApprovalRequired,
                                _ => ApprovalResultStatus::NotFound,
                            };
                            if status_enum == ApprovalResultStatus::ApprovalRequired {
                                let mut payload = JsonObject::new();
                                payload.insert("approvalToken".into(), json!(token));
                                payload.insert(
                                    "reason".into(),
                                    json!("Further approval is required."),
                                );
                                if let Ok(ev) = state.agent_v2.append_event(&AppendEventInput {
                                    session_id: session_id.clone(),
                                    user_id: user_id.clone(),
                                    command_id: Some(started.command.id.clone()),
                                    event_type: EventType::ApprovalRequired,
                                    payload,
                                }) {
                                    emit_agent_v2_events(&state, &user_id, &[ev]);
                                }
                            }
                            let msg = build_approval_result_message(status_enum);
                            if status_enum == ApprovalResultStatus::NotFound {
                                completion_status = CommandStatus::FailedRecoverable;
                                error_code = Some("COMMAND_EXECUTION_FAILED".into());
                                error_message = Some(msg.to_string());
                            }
                            let mut map = JsonObject::new();
                            map.insert("message".into(), json!(msg));
                            map.insert("status".into(), json!(status_str));
                            if let Some(pu) = outcome.get("policyUpdated") {
                                map.insert("policyUpdated".into(), pu.clone());
                            }
                            result_payload = Some(map);
                        }
                        Err(err) => {
                            completion_status = CommandStatus::FailedRecoverable;
                            error_code = Some("COMMAND_RUNTIME_EXCEPTION".into());
                            error_message = Some(err.message);
                        }
                    }
                } else {
                    completion_status = CommandStatus::FailedRecoverable;
                    error_code = Some("COMMAND_EXECUTION_FAILED".into());
                    error_message = Some("The chat runtime is not wired.".into());
                }
            }
            CommandType::Input | CommandType::Steer | CommandType::FollowUp => {
                let content = started
                    .command
                    .payload
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if content.is_empty() {
                    let msg = format!(
                        "{} requires non-empty content.",
                        started.command.command_type.as_str()
                    );
                    completion_status = CommandStatus::FailedRecoverable;
                    error_code = Some("COMMAND_EXECUTION_FAILED".into());
                    error_message = Some(msg.clone());
                    let mut map = JsonObject::new();
                    map.insert("message".into(), json!(msg));
                    result_payload = Some(map);
                } else if let Some(chat) = state.chat.get() {
                    match chat
                        .ws_messages
                        .handle_web_ui_message(
                            WebUiMessage {
                                conversation_id: conversation_id.clone(),
                                content,
                                user_id: user_id.clone(),
                                client_message_id: None,
                                attachments: None,
                            },
                            None,
                        )
                        .await
                    {
                        Ok(res) => {
                            let mut map = JsonObject::new();
                            map.insert("userMessageId".into(), json!(res.user_msg_id));
                            map.insert("agentMessageId".into(), json!(res.agent_msg_id));
                            map.insert("newConversationId".into(), json!(res.new_conversation_id));
                            map.insert("status".into(), json!("ok"));
                            match state
                                .messages
                                .lock()
                                .await
                                .get_message(&res.agent_msg_id, Some(&user_id))
                            {
                                Ok(Some(message)) => {
                                    map.insert("message".into(), json!(message.content));
                                    result_payload = Some(map);
                                }
                                outcome => {
                                    completion_status = CommandStatus::FailedRecoverable;
                                    error_code = Some("COMMAND_RESULT_UNAVAILABLE".into());
                                    error_message = Some(match outcome {
                                        Ok(None) => "Assistant message was not persisted.".into(),
                                        Err(error) => error.to_string(),
                                        _ => unreachable!(),
                                    });
                                }
                            }
                        }
                        Err(err) => {
                            completion_status = CommandStatus::FailedRecoverable;
                            error_code = Some("COMMAND_RUNTIME_EXCEPTION".into());
                            error_message = Some(err.message);
                        }
                    }
                } else {
                    let mut map = JsonObject::new();
                    map.insert("message".into(), json!("queued"));
                    map.insert("status".into(), json!("ok"));
                    result_payload = Some(map);
                }
            }
        }

        if let Ok(completed) = state.agent_v2.complete_command(&CompleteCommandInput {
            session_id: session_id.clone(),
            user_id: user_id.clone(),
            command_id: started.command.id,
            status: completion_status,
            result: result_payload,
            error_code,
            error_message,
        }) {
            emit_agent_v2_events(&state, &user_id, &completed.events);
        }

        if completion_status == CommandStatus::Aborted {
            break;
        }
    }
}

impl AgentV2Sessions for AgentV2SessionsPort {
    fn get_command_result(
        &self,
        command_id: &str,
        session_id: &str,
        user_id: &str,
    ) -> Result<Option<Value>, HandlerError> {
        self.get_session(session_id, user_id)?;
        self.0
            .agent_v2
            .get_command_result(command_id, session_id)
            .map_err(agent_v2_error)?
            .map(to_value)
            .transpose()
    }
    fn start_session<'a>(
        &'a self,
        input: StartSession,
    ) -> BoxFuture<'a, Result<StartedSession, HandlerError>> {
        Box::pin(async move {
            let requested_persona_id = input
                .persona_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);

            let conversation_id = if let Some(chat) = self.0.chat.get() {
                let existing = match input.conversation_id.as_deref() {
                    Some(conv_id) => Some(
                        chat.ws_messages
                            .get_conversation(conv_id, &input.user_id)?
                            .ok_or_else(|| {
                                HandlerError::new(ErrorCode::NotFound, "Conversation not found.")
                            })?,
                    ),
                    None => None,
                };
                let conv = match existing {
                    Some(conv) => conv,
                    None => {
                        let external_id = format!("agent-v2-{}", uuid::Uuid::new_v4());
                        chat.ws_messages.get_or_create_conversation(
                            "WebChat",
                            &external_id,
                            Some(input.title.as_deref().unwrap_or("Agent Session")),
                            &input.user_id,
                        )?
                    }
                };
                if let Some(persona_id) = &requested_persona_id {
                    if chat
                        .ws_personas
                        .find_persona(persona_id, &input.user_id)?
                        .is_none()
                    {
                        return Err(HandlerError::invalid("Persona not found."));
                    }
                    chat.ws_messages
                        .set_persona_id(&conv.id, persona_id, &input.user_id)?;
                }
                conv.id
            } else {
                let store = self.0.messages.lock().await;
                let existing = match input.conversation_id.as_deref() {
                    Some(conv_id) => Some(
                        store
                            .get_conversation(conv_id, Some(&input.user_id))
                            .map_err(store_error)?
                            .ok_or_else(|| {
                                HandlerError::new(ErrorCode::NotFound, "Conversation not found.")
                            })?,
                    ),
                    None => None,
                };
                let conv = match existing {
                    Some(conv) => conv,
                    None => {
                        let external_id = format!("agent-v2-{}", uuid::Uuid::new_v4());
                        store
                            .get_or_create_conversation(
                                "WebChat",
                                &external_id,
                                Some(input.title.as_deref().unwrap_or("Agent Session")),
                                Some(&input.user_id),
                            )
                            .map_err(store_error)?
                    }
                };
                if let Some(persona_id) = &requested_persona_id {
                    let personas = self.0.personas.lock().await;
                    let found = personas
                        .get_persona(persona_id)
                        .map_err(store_error)?
                        .filter(|p| p.user_id == input.user_id);
                    drop(personas);
                    if found.is_none() {
                        return Err(HandlerError::invalid("Persona not found."));
                    }
                    store
                        .update_persona_id(&conv.id, Some(persona_id), &input.user_id)
                        .map_err(store_error)?;
                }
                conv.id
            };

            let created = self
                .0
                .agent_v2
                .create_session(&CreateSessionInput {
                    user_id: input.user_id.clone(),
                    conversation_id,
                    status: Some(SessionStatus::Idle),
                })
                .map_err(agent_v2_error)?;

            emit_agent_v2_events(&self.0, &input.user_id, &created.events);

            Ok(StartedSession {
                session: to_value(created.session)?,
                events: to_value(created.events)?,
            })
        })
    }

    fn enqueue<'a>(
        &'a self,
        command: SessionCommand,
    ) -> BoxFuture<'a, Result<CommandResult, HandlerError>> {
        Box::pin(async move {
            let key = command.idempotency_key.as_deref();
            let id = command.command_id.as_deref();
            let input = match &command.kind {
                SessionCommandKind::Input(content) => {
                    input_command(&command.session_id, &command.user_id, content, key, id)
                }
                SessionCommandKind::Steer(instruction) => {
                    steer_command(&command.session_id, &command.user_id, instruction, key)
                }
                SessionCommandKind::FollowUp(content) => {
                    follow_up_command(&command.session_id, &command.user_id, content, key, id)
                }
                SessionCommandKind::ApprovalResponse {
                    approval_token,
                    approved,
                    approve_always,
                    tool_id,
                    tool_function_name,
                } => approval_command(
                    &command.session_id,
                    &command.user_id,
                    approval_token,
                    *approved,
                    *approve_always,
                    tool_id.as_deref(),
                    tool_function_name.as_deref(),
                    key,
                ),
                SessionCommandKind::Abort { reason } => abort_command(
                    &command.session_id,
                    &command.user_id,
                    reason.as_deref(),
                    key,
                ),
            };

            let mut handles = HashMap::new();
            let enqueued = enqueue_command(&self.0.agent_v2, &mut handles, &input, |_, _| {})
                .map_err(agent_v2_error)?;

            if !enqueued.reused {
                emit_agent_v2_events(&self.0, &command.user_id, &enqueued.events);
                let state = self.0.clone();
                let session_id = command.session_id.clone();
                let user_id = command.user_id.clone();
                tokio::spawn(async move {
                    process_agent_v2_queue(state, session_id, user_id).await;
                });
            }

            Ok(CommandResult {
                command: to_value(enqueued.command)?,
                session: to_value(enqueued.session)?,
            })
        })
    }

    fn get_session(&self, session_id: &str, user_id: &str) -> Result<Option<Value>, HandlerError> {
        let mut handles = HashMap::new();
        let snapshot = get_agent_v2_session(&self.0.agent_v2, &mut handles, session_id, user_id)
            .map_err(agent_v2_error)?;
        Ok(Some(to_value(snapshot)?))
    }

    fn list_sessions(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError> {
        let limit = i64::try_from(limit).unwrap_or(50);
        list_agent_v2_sessions(&self.0.agent_v2, user_id, limit)
            .map_err(agent_v2_error)?
            .into_iter()
            .map(to_value)
            .collect()
    }

    fn replay_events(&self, request: ReplayRequest) -> Result<Vec<Value>, HandlerError> {
        let limit = request.limit.map(|l| i64::try_from(l).unwrap_or(i64::MAX));
        replay_session_events(
            &self.0.agent_v2,
            &ReplayEventsInput {
                session_id: request.session_id,
                user_id: request.user_id,
                from_seq: request.from_seq as i64,
                limit,
            },
        )
        .map_err(agent_v2_error)?
        .into_iter()
        .map(to_value)
        .collect()
    }
}

/// The WS family's services for one connection, built from the gateway state.
///
/// The chat, store and persona ports come from the chat runtime, the pairing flows
/// from the channel family, and `sessions` from the Agent-v2 repository on `state`.
pub fn ws_services(state: &SharedState) -> WsServices {
    let messages = Arc::new(MessagesPorts(state.clone()));
    let chat = state.chat.get();
    let messages_port: Arc<dyn MessageService> = match chat {
        Some(chat) => chat.ws_messages.clone(),
        None => Arc::new(Unwired),
    };
    let store_port: Arc<dyn MessageStore> = match chat {
        Some(chat) => chat.ws_store.clone(),
        None => Arc::new(Unwired),
    };
    let personas_port: Arc<dyn PersonaStore> = match chat {
        Some(chat) => chat.ws_personas.clone(),
        None => Arc::new(Unwired),
    };
    let pairing_port: Arc<dyn ChannelPairing> = match state.channels.get() {
        Some(services) => Arc::new(ChannelsPairing(services.clone())),
        None => Arc::new(Unwired),
    };
    WsServices {
        messages: messages_port,
        store: store_port,
        personas: personas_port,
        pairing: pairing_port,
        sessions: Arc::new(AgentV2SessionsPort(state.clone())),
        events: Arc::new(RegistryEvents(state.clone())),
        swarms: messages.clone(),
        inbox: messages,
        inbox_rate_limit: Arc::new(InboxLimit(state.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use betaclaw_core::config::GatewayConfig;

    #[tokio::test]
    async fn agent_v2_sessions_port_round_trip() {
        let mut config = GatewayConfig::from_env().expect("config");
        config.logs_db_path = ":memory:".into();
        config.personas_db_path = ":memory:".into();
        config.messages_db_path = ":memory:".into();
        let state = Arc::new(AppState::new(config).expect("state"));
        let port = AgentV2SessionsPort(state);

        let started = port
            .start_session(StartSession {
                user_id: "user-1".into(),
                title: Some("Session A".into()),
                persona_id: None,
                conversation_id: None,
            })
            .await
            .expect("start_session");
        let session_id = started.session["id"].as_str().expect("id").to_string();
        assert_eq!(started.session["status"], "idle");
        assert_eq!(started.events.as_array().expect("events").len(), 1);

        let fetched = port
            .get_session(&session_id, "user-1")
            .expect("get_session")
            .expect("present");
        assert_eq!(fetched["id"], session_id);

        let listed = port.list_sessions("user-1", 10).expect("list_sessions");
        assert_eq!(listed.len(), 1);

        let replayed = port
            .replay_events(ReplayRequest {
                session_id: session_id.clone(),
                user_id: "user-1".into(),
                from_seq: 0.0,
                limit: Some(10),
            })
            .expect("replay_events");
        assert_eq!(replayed.len(), 1);

        let enqueued = port
            .enqueue(SessionCommand {
                session_id: session_id.clone(),
                user_id: "user-1".into(),
                kind: SessionCommandKind::Input("hello".into()),
                idempotency_key: Some("idem-1".into()),
                command_id: None,
            })
            .await
            .expect("enqueue");
        assert_eq!(enqueued.command["commandType"], "input");
    }
}
