//! Port of `src/server/agent-v2/types.ts`, `src/shared/agentV2Types.ts` and
//! `src/server/agent-v2/repository/types.ts`.
//!
//! The public structs serialize with the TypeScript camelCase keys, so the same
//! JSON can reach the web client later. The row structs and inputs are the
//! repository's own shapes and are not a wire format.
//!
//! Not ported: `AgentCommandResult` (a command result is a JSON object, which
//! `Record<string, unknown>` already covers), and `LifecycleHookContext` and
//! `LifecycleHookOutcome`, which belong to the extension host.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `AGENT_V2_SCHEMA_VERSION` in `src/shared/agentV2Types.ts`.
pub const AGENT_V2_SCHEMA_VERSION: &str = "2.1";

/// `Record<string, unknown>`.
pub type JsonObject = Map<String, Value>;

text_enum!(SessionStatus {
    Idle => "idle",
    Running => "running",
    Completed => "completed",
    Aborted => "aborted",
    Error => "error",
    ErrorRecoverable => "error_recoverable",
});

text_enum!(CommandType {
    Input => "input",
    Steer => "steer",
    FollowUp => "follow_up",
    Approval => "approval",
    Abort => "abort",
});

text_enum!(CommandStatus {
    Queued => "queued",
    Running => "running",
    Completed => "completed",
    Failed => "failed",
    FailedRecoverable => "failed_recoverable",
    Aborted => "aborted",
});

text_enum!(EventType {
    SessionUpdated => "agent.v2.session.updated",
    CommandQueued => "agent.v2.command.queued",
    CommandStarted => "agent.v2.command.started",
    CommandCompleted => "agent.v2.command.completed",
    ModelDelta => "agent.v2.model.delta",
    ToolStarted => "agent.v2.tool.started",
    ToolCompleted => "agent.v2.tool.completed",
    ApprovalRequired => "agent.v2.approval.required",
    SessionCompleted => "agent.v2.session.completed",
    Error => "agent.v2.error",
});

text_enum!(LifecycleHookStage {
    SessionBeforeStart => "session.before_start",
    SessionAfterStart => "session.after_start",
    CommandBeforeEnqueue => "command.before_enqueue",
    CommandBeforeExecute => "command.before_execute",
    ModelBeforeDispatch => "model.before_dispatch",
    ModelAfterDispatch => "model.after_dispatch",
    ToolBeforeExecute => "tool.before_execute",
    ToolAfterExecute => "tool.after_execute",
    ApprovalRequired => "approval.required",
    SessionBeforeComplete => "session.before_complete",
    SessionAfterComplete => "session.after_complete",
});

text_enum!(SigningKeyStatus {
    Active => "active",
    Rotated => "rotated",
    Revoked => "revoked",
});

/// `AgentSessionSnapshot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSnapshot {
    pub id: String,
    pub user_id: String,
    pub conversation_id: String,
    pub status: SessionStatus,
    pub revision: i64,
    pub last_seq: i64,
    pub queue_depth: i64,
    pub running_command_id: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// `AgentCommand`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub id: String,
    pub session_id: String,
    pub command_type: CommandType,
    pub priority: i64,
    pub status: CommandStatus,
    pub payload: JsonObject,
    pub idempotency_key: Option<String>,
    pub enqueued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub result: Option<JsonObject>,
}

/// `AgentV2EventEnvelope`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub schema_version: String,
    pub event_id: String,
    pub session_id: String,
    pub command_id: Option<String>,
    pub seq: i64,
    pub emitted_at: String,
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub payload: JsonObject,
}

/// `ExtensionManifestV1`. `hookStages` is typed as a union in TypeScript and is
/// read here through [`LifecycleHookStage`], so an unknown stage makes the stored
/// manifest unreadable and it is skipped by the list call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifestV1 {
    pub schema_version: String,
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub digest: String,
    pub key_id: String,
    pub signature: String,
    pub module_path: String,
    pub hook_stages: Vec<LifecycleHookStage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_closed_stages: Option<Vec<LifecycleHookStage>>,
    /// Milliseconds. TypeScript accepts any number; a fractional value makes the
    /// stored manifest unreadable here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// `AgentV2SigningKeyRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningKeyRecord {
    pub key_id: String,
    pub algorithm: String,
    pub public_key_pem: String,
    pub status: SigningKeyStatus,
    pub created_at: String,
    pub rotated_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// One `agent_v2_sessions` row.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub user_id: String,
    pub conversation_id: String,
    pub status: SessionStatus,
    pub revision: i64,
    pub last_seq: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// One `agent_v2_commands` row. The payload and result stay JSON text, as stored.
#[derive(Debug, Clone)]
pub struct CommandRow {
    pub id: String,
    pub session_id: String,
    pub command_type: CommandType,
    pub priority: i64,
    pub status: CommandStatus,
    pub payload_json: String,
    pub idempotency_key: Option<String>,
    pub enqueued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub result_json: Option<String>,
}

/// One `agent_v2_events` row.
#[derive(Debug, Clone)]
pub struct EventRow {
    pub id: String,
    pub session_id: String,
    pub command_id: Option<String>,
    pub seq: i64,
    pub event_type: EventType,
    pub payload_json: String,
    pub emitted_at: String,
}

/// An event to write. The sequence number is assigned by the insert.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub event_type: EventType,
    pub payload: JsonObject,
}

#[derive(Debug, Clone)]
pub struct CreateSessionInput {
    pub user_id: String,
    pub conversation_id: String,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Clone)]
pub struct CreateSessionResult {
    pub session: AgentSessionSnapshot,
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Clone)]
pub struct EnqueueAgentCommandInput {
    pub session_id: String,
    pub user_id: String,
    pub command_type: CommandType,
    pub priority: i64,
    pub payload: JsonObject,
    pub idempotency_key: Option<String>,
    /// Pre-generated command ID, for callers that need it before the enqueue.
    pub command_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EnqueueAgentCommandResult {
    pub command: AgentCommand,
    pub reused: bool,
    pub session: AgentSessionSnapshot,
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Clone)]
pub struct StartNextCommandResult {
    pub command: AgentCommand,
    pub session: AgentSessionSnapshot,
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Clone)]
pub struct CompleteCommandInput {
    pub session_id: String,
    pub user_id: String,
    pub command_id: String,
    pub status: CommandStatus,
    /// `None` is stored as SQL `NULL`, as an `undefined` result is in TypeScript.
    pub result: Option<JsonObject>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompleteCommandResult {
    pub command: AgentCommand,
    pub session: AgentSessionSnapshot,
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Clone)]
pub struct AppendEventInput {
    pub session_id: String,
    pub user_id: String,
    pub command_id: Option<String>,
    pub event_type: EventType,
    pub payload: JsonObject,
}

#[derive(Debug, Clone)]
pub struct ReplayEventsInput {
    pub session_id: String,
    pub user_id: String,
    pub from_seq: i64,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct UpsertSigningKeyInput {
    pub key_id: String,
    pub algorithm: String,
    pub public_key_pem: String,
    pub status: Option<SigningKeyStatus>,
    pub rotated_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResult {
    pub recovered_commands: usize,
    pub touched_sessions: usize,
}
