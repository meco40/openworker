//! Port of `src/server/channels/messages/repository/types.ts` plus the domain
//! shapes the repositories borrow from four neighbouring TypeScript modules.
//!
//! | TypeScript                                        | Rust                       |
//! | ------------------------------------------------- | -------------------------- |
//! | `repository/types.ts`                             | this module                |
//! | `src/server/channels/messages/channelBindings.ts` | this module                |
//! | `src/server/channels/adapters/types.ts`           | [`ChannelKey`]             |
//! | `src/shared/domain/types.ts`                      | [`Conversation`], [`ChannelType`] |
//! | `src/shared/domain/agentRoom.types.ts`            | [`SwarmUnit`], [`SwarmFriction`], [`PhaseBufferEntry`] |
//!
//! # Unchecked casts
//!
//! `toConversation`, `toMessage` and `toChannelBinding`
//! (`src/server/channels/messages/messageRowMappers.ts`) cast `channel_type`,
//! `platform`, `channel` and `status` without validating them. The port keeps
//! the raw `String` in those record fields so an unknown value is neither
//! rewritten nor rejected. The closed sets are still published as enums
//! ([`ChannelType`], [`ChannelKey`], [`ChannelBindingStatus`]) because callers
//! need a catalogue, and [`crate::messages_store::agent_room`] has to normalise
//! `status` / `current_phase` exactly like `normalizeStatus` / `normalizePhase`
//! do.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::LEGACY_MESSAGES_USER_ID;

/// `LEGACY_LOCAL_USER_ID` from `src/server/auth/constants.ts:1`.
///
/// **This is deliberately not `crate::auth::LEGACY_LOCAL_USER_ID`.** The Rust
/// constant in `auth/principal.rs:8` carries the value `local-user`, while the
/// TypeScript constant this store actually persists — it is interpolated into
/// the `conversations.user_id` column DEFAULT and used by `normalizeUserId` — is
/// `legacy-local-user`. Using the Rust value would write and query a user id
/// that no TypeScript row ever uses, so the inbox of a pre-multi-tenant install
/// would come back empty. The mismatch is reported in the slice hand-over.
pub const LEGACY_LOCAL_USER_ID: &str = LEGACY_MESSAGES_USER_ID;

/// `SqliteMessageRepository.normalizeUserId` from
/// `src/server/channels/messages/sqliteMessageRepository.ts:71-74`.
///
/// `userId?.trim()` is truthy-checked, so an empty or whitespace-only id falls
/// back to the legacy local user.
pub fn normalize_user_id(user_id: Option<&str>) -> String {
    user_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string())
}

/// `userId ? this.normalizeUserId(userId) : null` as used by the read queries.
///
/// The truthy test runs on the raw value, so `""` means "no user scope" while
/// `"   "` is scoped to the legacy user. `normalize_user_id` alone would scope
/// `""` to the legacy user, which the source never does.
pub fn scoped_user_id(user_id: Option<&str>) -> Option<String> {
    user_id
        .filter(|value| !value.is_empty())
        .map(|value| normalize_user_id(Some(value)))
}

/// `new Date().toISOString()` — millisecond precision, always UTC, `Z` suffix.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ─── Enumerations ───────────────────────────────────────────────────────────

/// `CHECK(role IN ('user', 'agent', 'system'))` on the `messages` table. Unlike
/// the channel columns the database itself rejects every other value, so this
/// can be a closed enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Agent,
    System,
}

impl MessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Agent => "agent",
            MessageRole::System => "system",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(MessageRole::User),
            "agent" => Some(MessageRole::Agent),
            "system" => Some(MessageRole::System),
            _ => None,
        }
    }
}

/// `ChannelType` from `src/shared/domain/types.ts:1-10`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelType {
    #[serde(rename = "WhatsApp")]
    WhatsApp,
    #[serde(rename = "Telegram")]
    Telegram,
    #[serde(rename = "Slack")]
    Slack,
    #[serde(rename = "Discord")]
    Discord,
    #[serde(rename = "WebChat")]
    WebChat,
    #[serde(rename = "iMessage")]
    IMessage,
    #[serde(rename = "AgentRoom")]
    AgentRoom,
}

impl ChannelType {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelType::WhatsApp => "WhatsApp",
            ChannelType::Telegram => "Telegram",
            ChannelType::Slack => "Slack",
            ChannelType::Discord => "Discord",
            ChannelType::WebChat => "WebChat",
            ChannelType::IMessage => "iMessage",
            ChannelType::AgentRoom => "AgentRoom",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "WhatsApp" => Some(ChannelType::WhatsApp),
            "Telegram" => Some(ChannelType::Telegram),
            "Slack" => Some(ChannelType::Slack),
            "Discord" => Some(ChannelType::Discord),
            "WebChat" => Some(ChannelType::WebChat),
            "iMessage" => Some(ChannelType::IMessage),
            "AgentRoom" => Some(ChannelType::AgentRoom),
            _ => None,
        }
    }
}

/// `ChannelKey` from `src/server/channels/adapters/types.ts:1-8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKey {
    Webchat,
    #[serde(rename = "agent_room")]
    AgentRoom,
    Telegram,
    Whatsapp,
    Discord,
    Imessage,
    Slack,
}

impl ChannelKey {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelKey::Webchat => "webchat",
            ChannelKey::AgentRoom => "agent_room",
            ChannelKey::Telegram => "telegram",
            ChannelKey::Whatsapp => "whatsapp",
            ChannelKey::Discord => "discord",
            ChannelKey::Imessage => "imessage",
            ChannelKey::Slack => "slack",
        }
    }
}

/// `ChannelBindingStatus` from `src/server/channels/messages/channelBindings.ts:3-9`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelBindingStatus {
    Idle,
    Pairing,
    AwaitingCode,
    Connected,
    Disconnected,
    Error,
}

impl ChannelBindingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelBindingStatus::Idle => "idle",
            ChannelBindingStatus::Pairing => "pairing",
            ChannelBindingStatus::AwaitingCode => "awaiting_code",
            ChannelBindingStatus::Connected => "connected",
            ChannelBindingStatus::Disconnected => "disconnected",
            ChannelBindingStatus::Error => "error",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(ChannelBindingStatus::Idle),
            "pairing" => Some(ChannelBindingStatus::Pairing),
            "awaiting_code" => Some(ChannelBindingStatus::AwaitingCode),
            "connected" => Some(ChannelBindingStatus::Connected),
            "disconnected" => Some(ChannelBindingStatus::Disconnected),
            "error" => Some(ChannelBindingStatus::Error),
            _ => None,
        }
    }
}

/// `AgentRoomSwarmStatus` from `repository/types.ts:68`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentRoomSwarmStatus {
    Idle,
    Running,
    Hold,
    Completed,
    Aborted,
    Error,
}

impl AgentRoomSwarmStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRoomSwarmStatus::Idle => "idle",
            AgentRoomSwarmStatus::Running => "running",
            AgentRoomSwarmStatus::Hold => "hold",
            AgentRoomSwarmStatus::Completed => "completed",
            AgentRoomSwarmStatus::Aborted => "aborted",
            AgentRoomSwarmStatus::Error => "error",
        }
    }

    /// `normalizeStatus` from `repository/queries/agentRoom.ts:81-93`.
    pub fn parse_or_idle(value: &str) -> Self {
        match value {
            "running" => AgentRoomSwarmStatus::Running,
            "hold" => AgentRoomSwarmStatus::Hold,
            "completed" => AgentRoomSwarmStatus::Completed,
            "aborted" => AgentRoomSwarmStatus::Aborted,
            "error" => AgentRoomSwarmStatus::Error,
            _ => AgentRoomSwarmStatus::Idle,
        }
    }
}

/// `AgentRoomSwarmPhase` from `repository/types.ts:70-76`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRoomSwarmPhase {
    Analysis,
    Research,
    Ideation,
    Critique,
    BestCase,
    Result,
}

impl AgentRoomSwarmPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentRoomSwarmPhase::Analysis => "analysis",
            AgentRoomSwarmPhase::Research => "research",
            AgentRoomSwarmPhase::Ideation => "ideation",
            AgentRoomSwarmPhase::Critique => "critique",
            AgentRoomSwarmPhase::BestCase => "best_case",
            AgentRoomSwarmPhase::Result => "result",
        }
    }

    /// `normalizePhase` from `repository/queries/agentRoom.ts:67-79`.
    pub fn parse_or_analysis(value: &str) -> Self {
        match value {
            "research" => AgentRoomSwarmPhase::Research,
            "ideation" => AgentRoomSwarmPhase::Ideation,
            "critique" => AgentRoomSwarmPhase::Critique,
            "best_case" => AgentRoomSwarmPhase::BestCase,
            "result" => AgentRoomSwarmPhase::Result,
            _ => AgentRoomSwarmPhase::Analysis,
        }
    }
}

/// `AgentRoomSwarmUnit` / `SwarmUnit` from `repository/types.ts:78-81`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmUnit {
    pub persona_id: String,
    pub role: String,
}

/// `AgentRoomSwarmFriction` / `SwarmFriction` from `repository/types.ts:83-89`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmFriction {
    pub level: String,
    pub confidence: f64,
    pub hold: bool,
    pub reasons: Vec<String>,
    pub updated_at: String,
}

impl SwarmFriction {
    /// `DEFAULT_FRICTION` from `repository/queries/agentRoom.ts:13-19`.
    pub fn default_friction() -> Self {
        Self {
            level: "low".to_string(),
            confidence: 0.0,
            hold: false,
            reasons: Vec::new(),
            updated_at: chrono::DateTime::from_timestamp(0, 0)
                .expect("the unix epoch is representable")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }
    }
}

/// `PhaseBufferEntry` from `src/shared/domain/agentRoom.types.ts:36-40`.
///
/// The column is written exclusively by
/// [`AgentRoomSwarmPatch::phase_buffer`](super::agent_room::AgentRoomSwarmPatch)
/// and only legacy rows ever contain the colon-delimited string form, which
/// [`parse_phase_buffer`](super::agent_room::parse_phase_buffer) upgrades on
/// read. Unknown `type` tags are therefore skipped rather than kept verbatim,
/// which is the one deliberate deviation from the unchecked
/// `entries.push(item as PhaseBufferEntry)` in the TypeScript source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PhaseBufferEntry {
    #[serde(rename = "agentsession")]
    AgentSession {
        #[serde(rename = "personaId")]
        persona_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "lastSeq")]
        last_seq: i64,
    },
    #[serde(rename = "speaker")]
    Speaker {
        #[serde(rename = "personaId")]
        persona_id: String,
    },
    #[serde(rename = "speakerOverride")]
    SpeakerOverride {
        #[serde(rename = "personaId")]
        persona_id: String,
    },
    #[serde(rename = "phaseSummaryPending")]
    PhaseSummaryPending {
        #[serde(rename = "fromPhase")]
        from_phase: String,
    },
}

// ─── Data shapes ────────────────────────────────────────────────────────────

/// `Conversation` from `src/shared/domain/types.ts:92-104`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// Unvalidated: `toConversation` casts the column straight to `ChannelType`.
    pub channel_type: String,
    pub external_chat_id: Option<String>,
    pub user_id: String,
    /// Never populated by a query in this slice; absent in TypeScript too, so it
    /// is omitted from the JSON instead of serialised as `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub title: String,
    pub model_override: Option<String>,
    pub persona_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `StoredMessage` from `repository/types.ts:8-19`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub seq: Option<i64>,
    pub role: String,
    pub content: String,
    /// Unvalidated, like `Conversation::channel_type`.
    pub platform: String,
    pub external_msg_id: Option<String>,
    pub sender_name: Option<String>,
    /// Raw JSON text; the column is nullable and never parsed by this slice
    /// except in [`mark_messages_memory_pending`](super::messages::MessageQueries::mark_messages_memory_pending).
    pub metadata: Option<String>,
    pub created_at: String,
}

/// `CreateConversationInput` from `repository/types.ts:23-29`.
#[derive(Debug, Clone, Default)]
pub struct CreateConversationInput<'a> {
    pub channel_type: &'a str,
    pub external_chat_id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub persona_id: Option<&'a str>,
}

/// `SaveMessageInput` from `repository/types.ts:31-40`.
#[derive(Debug, Clone)]
pub struct SaveMessageInput<'a> {
    pub conversation_id: &'a str,
    pub role: MessageRole,
    pub content: &'a str,
    pub platform: &'a str,
    pub external_msg_id: Option<&'a str>,
    pub sender_name: Option<&'a str>,
    pub metadata: Option<&'a Value>,
    pub client_message_id: Option<&'a str>,
}

/// `ConversationContextState` from `repository/types.ts:42-47`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContextState {
    pub conversation_id: String,
    pub summary_text: String,
    pub summary_upto_seq: i64,
    pub updated_at: String,
}

/// `PersonaProjectRecord` from `repository/types.ts:49-59`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonaProjectRecord {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub name: String,
    pub slug: String,
    pub workspace_path: String,
    pub workspace_relative_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Argument of `ProjectQueries::create_project`
/// (`repository/queries/projects.ts:14-20`).
#[derive(Debug, Clone)]
pub struct CreateProjectInput<'a> {
    pub user_id: &'a str,
    pub persona_id: &'a str,
    pub name: &'a str,
    pub workspace_path: &'a str,
    pub workspace_relative_path: Option<&'a str>,
}

/// `ConversationProjectState` from `repository/types.ts:61-66`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationProjectState {
    pub conversation_id: String,
    pub active_project_id: Option<String>,
    pub guard_approved_without_project: bool,
    pub updated_at: Option<String>,
}

/// `AgentRoomSwarmRecord` from `repository/types.ts:91-116`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomSwarmRecord {
    pub id: String,
    pub conversation_id: String,
    pub user_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub task: String,
    pub lead_persona_id: String,
    pub units: Vec<SwarmUnit>,
    pub status: AgentRoomSwarmStatus,
    pub current_phase: AgentRoomSwarmPhase,
    pub consensus_score: i64,
    pub hold_flag: bool,
    pub artifact: String,
    pub artifact_history: Vec<String>,
    pub friction: SwarmFriction,
    pub last_seq: i64,
    pub current_deploy_command_id: Option<String>,
    pub search_enabled: bool,
    pub swarm_template: Option<String>,
    pub pause_between_phases: bool,
    /// Per-agent responses collected so far in the current phase (sequential
    /// execution).
    pub phase_buffer: Vec<PhaseBufferEntry>,
    pub created_at: String,
    pub updated_at: String,
}

/// `AgentRoomSwarmMetrics` from `repository/types.ts:118-122`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoomSwarmMetrics {
    pub running_swarms: i64,
    pub hold_swarms: i64,
    pub last_error_at: Option<String>,
}

/// Argument of `AgentRoomQueries::create_agent_room_swarm`
/// (`repository/queries/agentRoom.ts:131-150`).
#[derive(Debug, Clone, Default)]
pub struct CreateAgentRoomSwarmInput<'a> {
    pub conversation_id: &'a str,
    pub user_id: &'a str,
    pub title: &'a str,
    pub task: &'a str,
    pub lead_persona_id: &'a str,
    pub units: Vec<SwarmUnit>,
    pub session_id: Option<&'a str>,
    pub status: Option<AgentRoomSwarmStatus>,
    pub current_phase: Option<AgentRoomSwarmPhase>,
    pub consensus_score: Option<f64>,
    pub hold_flag: Option<bool>,
    pub artifact: Option<&'a str>,
    pub artifact_history: Vec<String>,
    pub friction: Option<SwarmFriction>,
    pub last_seq: Option<f64>,
    pub search_enabled: Option<bool>,
    pub swarm_template: Option<&'a str>,
    pub pause_between_phases: Option<bool>,
}

/// Partial update accepted by
/// [`AgentRoomQueries::update_agent_room_swarm`](super::agent_room::AgentRoomQueries::update_agent_room_swarm)
/// — the `patch` argument of `updateAgentRoomSwarm`
/// (`repository/queries/agentRoom.ts:266-288`).
///
/// `session_id`, `current_deploy_command_id` and `swarm_template` use
/// `Option<Option<String>>` for the same reason
/// [`PersonaUpdate`](crate::personas::repository::PersonaUpdate) does: the outer
/// `Option` is "not supplied", the inner one is "supplied as null".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentRoomSwarmPatch {
    pub session_id: Option<Option<String>>,
    pub title: Option<String>,
    pub task: Option<String>,
    pub lead_persona_id: Option<String>,
    pub units: Option<Vec<SwarmUnit>>,
    pub status: Option<AgentRoomSwarmStatus>,
    pub current_phase: Option<AgentRoomSwarmPhase>,
    pub consensus_score: Option<i64>,
    pub hold_flag: Option<bool>,
    pub artifact: Option<String>,
    pub artifact_history: Option<Vec<String>>,
    pub friction: Option<SwarmFriction>,
    pub last_seq: Option<i64>,
    pub current_deploy_command_id: Option<Option<String>>,
    pub search_enabled: Option<bool>,
    pub swarm_template: Option<Option<String>>,
    pub pause_between_phases: Option<bool>,
    pub phase_buffer: Option<Vec<PhaseBufferEntry>>,
}

// ─── Channel bindings ───────────────────────────────────────────────────────

/// `ChannelBinding` from `src/server/channels/messages/channelBindings.ts:11-24`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBinding {
    pub user_id: String,
    /// Unvalidated, like `Conversation::channel_type`.
    pub channel: String,
    /// Unvalidated, like `Conversation::channel_type`.
    pub status: String,
    pub external_peer_id: Option<String>,
    pub peer_name: Option<String>,
    pub transport: Option<String>,
    pub metadata: Option<String>,
    pub persona_id: Option<String>,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `UpsertChannelBindingInput` from `channelBindings.ts:26-33`.
#[derive(Debug, Clone, Default)]
pub struct UpsertChannelBindingInput<'a> {
    pub user_id: &'a str,
    pub channel: &'a str,
    pub status: &'a str,
    pub external_peer_id: Option<&'a str>,
    pub peer_name: Option<&'a str>,
    pub transport: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}

// ─── Search ─────────────────────────────────────────────────────────────────

/// `SearchMessagesOptions` from `repository/types.ts:126-132`.
#[derive(Debug, Clone, Default)]
pub struct SearchMessagesOptions<'a> {
    pub user_id: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
    pub persona_id: Option<&'a str>,
    pub role: Option<MessageRole>,
    pub limit: Option<i64>,
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

/// `InboxCursor` from `repository/types.ts:134-137`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCursor {
    pub updated_at: String,
    pub conversation_id: String,
}

/// `InboxLastMessage` from `repository/types.ts:139-145`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxLastMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub platform: String,
}

/// `InboxItemRecord` from `repository/types.ts:147-153`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItemRecord {
    pub conversation_id: String,
    pub channel_type: String,
    pub title: String,
    pub updated_at: String,
    pub last_message: Option<InboxLastMessage>,
}

/// `InboxListInput` from `repository/types.ts:155-161`.
#[derive(Debug, Clone, Default)]
pub struct InboxListInput<'a> {
    pub user_id: &'a str,
    pub channel: Option<&'a str>,
    pub query: Option<&'a str>,
    pub limit: Option<i64>,
    pub cursor: Option<InboxCursor>,
}

/// `InboxListResult` from `repository/types.ts:163-169`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxListResult {
    pub items: Vec<InboxItemRecord>,
    pub limit: i64,
    pub has_more: bool,
    pub next_cursor: Option<InboxCursor>,
    pub total_matched: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_user_id_is_no_scope_but_a_blank_one_is_the_legacy_user() {
        assert_eq!(scoped_user_id(None), None);
        assert_eq!(scoped_user_id(Some("")), None);
        assert_eq!(
            scoped_user_id(Some("   ")),
            Some(LEGACY_LOCAL_USER_ID.to_string())
        );
        assert_eq!(scoped_user_id(Some(" u-1 ")), Some("u-1".to_string()));
    }

    #[test]
    fn normalize_user_id_falls_back_for_blank_input() {
        assert_eq!(normalize_user_id(None), "legacy-local-user");
        assert_eq!(normalize_user_id(Some("")), "legacy-local-user");
        assert_eq!(normalize_user_id(Some("   ")), "legacy-local-user");
        assert_eq!(normalize_user_id(Some("  u-1  ")), "u-1");
    }

    #[test]
    fn legacy_user_id_matches_the_typescript_constant() {
        // Hard-coded on purpose: this literal is the storage contract.
        assert_eq!(LEGACY_LOCAL_USER_ID, "legacy-local-user");
        assert_ne!(
            LEGACY_LOCAL_USER_ID,
            crate::auth::LEGACY_LOCAL_USER_ID,
            "the Rust auth constant still carries the older `local-user` value"
        );
    }

    #[test]
    fn now_iso_has_millisecond_precision_and_a_z_suffix() {
        let stamp = now_iso();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn swarm_status_and_phase_normalise_like_the_source() {
        assert_eq!(
            AgentRoomSwarmStatus::parse_or_idle("nonsense"),
            AgentRoomSwarmStatus::Idle
        );
        assert_eq!(
            AgentRoomSwarmStatus::parse_or_idle("running"),
            AgentRoomSwarmStatus::Running
        );
        assert_eq!(
            AgentRoomSwarmPhase::parse_or_analysis(""),
            AgentRoomSwarmPhase::Analysis
        );
        assert_eq!(
            AgentRoomSwarmPhase::parse_or_analysis("best_case"),
            AgentRoomSwarmPhase::BestCase
        );
    }

    #[test]
    fn default_friction_uses_the_unix_epoch() {
        let friction = SwarmFriction::default_friction();
        assert_eq!(friction.level, "low");
        assert_eq!(friction.confidence, 0.0);
        assert!(!friction.hold);
        assert!(friction.reasons.is_empty());
        assert_eq!(friction.updated_at, "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn phase_buffer_entries_round_trip_camel_case() {
        let entries = vec![
            PhaseBufferEntry::AgentSession {
                persona_id: "p-1".into(),
                session_id: "s-1".into(),
                last_seq: 7,
            },
            PhaseBufferEntry::Speaker {
                persona_id: "p-2".into(),
            },
            PhaseBufferEntry::SpeakerOverride {
                persona_id: "p-3".into(),
            },
            PhaseBufferEntry::PhaseSummaryPending {
                from_phase: "analysis".into(),
            },
        ];
        let encoded = serde_json::to_string(&entries).expect("encode");
        assert!(
            encoded.contains(r#"{"type":"agentsession","personaId":"p-1""#),
            "{encoded}"
        );
        assert!(
            encoded.contains(r#"{"type":"phaseSummaryPending","fromPhase":"analysis"}"#),
            "{encoded}"
        );
        let decoded: Vec<PhaseBufferEntry> = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, entries);
    }

    #[test]
    fn conversation_omits_the_absent_workspace_id() {
        let conversation = Conversation {
            id: "c-1".into(),
            channel_type: "WebChat".into(),
            external_chat_id: None,
            user_id: "u-1".into(),
            workspace_id: None,
            title: "WebChat".into(),
            model_override: None,
            persona_id: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        };
        let encoded = serde_json::to_string(&conversation).expect("encode");
        assert!(!encoded.contains("workspaceId"), "{encoded}");
    }
}
/// Errors raised by the messages store.
///
/// The `Validation` variants carry the literal message of the corresponding
/// `throw new Error(...)` in the TypeScript source, so the Next.js route handler
/// that catches them keeps its current response body.
///
/// Defined here rather than in `repository.rs` because every query module in
/// this directory returns it.
#[derive(Debug, thiserror::Error)]
pub enum MessageRepositoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("{0}")]
    Validation(&'static str),
    #[error("JSON error: {0}")]
    Json(String),
    /// The insert succeeded but the follow-up `SELECT` found nothing. This can
    /// only happen if another writer removed the row in between, or if a trigger
    /// suppressed the insert; both are bugs, so the port fails loudly instead of
    /// dereferencing a `null` like the TypeScript non-null assertion does.
    #[error("row vanished after insert into {context}")]
    MissingRow { context: &'static str },
    /// `throw new Error('Conversation not found for context update.')`.
    #[error("Conversation not found for context update.")]
    ConversationNotFoundForContext,
}
