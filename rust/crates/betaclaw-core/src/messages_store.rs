//! Messages, conversations and inbox store.
//!
//! Mirrors `src/server/channels/messages/` in the TypeScript backend:
//!
//! | TypeScript                                        | Rust            |
//! | ------------------------------------------------- | --------------- |
//! | `sqliteMessageRepository.ts`                      | [`repository`]  |
//! | `repository/types.ts`                             | [`types`]       |
//! | `messageRowMappers.ts`                            | [`row_mappers`] |
//! | `repository/migrations/index.ts`                  | [`migrations`]  |
//! | `repository/constants/stopWords.ts`               | [`stop_words`]  |
//! | `repository/utils/ftsHelpers.ts`                  | [`fts`]         |
//! | `repository/queries/conversations.ts`             | [`conversations`] |
//! | `repository/queries/messages.ts`                  | [`messages`]    |
//! | `repository/queries/context.ts`                   | [`context`]     |
//! | `repository/queries/channelBindings.ts`           | [`channel_bindings`] |
//! | `repository/queries/search.ts`                    | [`search`]      |
//! | `repository/queries/delete.ts`                    | [`delete`]      |
//! | `repository/queries/projects.ts`                  | [`projects`]    |
//! | `repository/queries/agentRoom.ts`                 | [`agent_room`]  |
//! | `repository/queries/inbox.ts`                     | [`inbox`]       |
//! | `diagnostics/chatDisplayTrace.ts` (query timers)  | [`trace`]       |
//!
//! The seven table names, the column names and every statement of
//! [`migrations`] are part of the storage contract: the Rust gateway and the
//! TypeScript backend must be able to read the same `.local/messages.db`.
//!
//! # Shared file, see [`repository::MessagesStore`]
//!
//! `.local/messages.db` is also the fallback database of the memory, knowledge,
//! proactive and security stores. This module only ever adds its own seven
//! tables and never drops or repurposes a column; the `MESSAGES_DB_PATH`
//! resolution for those consumers belongs to slices S5, S7 and S12.

pub mod agent_room;
pub mod channel_bindings;
pub mod context;
pub mod conversations;
pub mod delete;
pub mod fts;
pub mod inbox;
pub mod messages;
pub mod migrations;
pub mod projects;
pub mod repository;
pub mod row_mappers;
pub mod search;
pub mod stop_words;
pub mod trace;
pub mod types;

/// `LEGACY_LOCAL_USER_ID` from `src/server/auth/constants.ts:1`.
///
/// Deliberately **not** re-exported from [`crate::auth`]: that constant carries
/// a different value, and this one is what the `conversations.user_id` column
/// default and `normalizeUserId` are built from. See
/// [`types::LEGACY_LOCAL_USER_ID`] for the full explanation.
pub const LEGACY_MESSAGES_USER_ID: &str = "legacy-local-user";

pub use repository::{default_messages_db_path, MessagesStore};

pub use types::{
    normalize_user_id, now_iso, AgentRoomSwarmMetrics, AgentRoomSwarmPatch, AgentRoomSwarmPhase,
    AgentRoomSwarmRecord, AgentRoomSwarmStatus, ChannelBinding, ChannelBindingStatus, ChannelKey,
    ChannelType, Conversation, ConversationContextState, ConversationProjectState,
    CreateAgentRoomSwarmInput, CreateConversationInput, CreateProjectInput, InboxCursor,
    InboxItemRecord, InboxLastMessage, InboxListInput, InboxListResult, MessageRepositoryError,
    MessageRole, PersonaProjectRecord, PhaseBufferEntry, SaveMessageInput, SearchMessagesOptions,
    StoredMessage, SwarmFriction, SwarmUnit, UpsertChannelBindingInput,
};

pub use fts::build_fts_query;
pub use migrations::run_migrations;
pub use stop_words::STOP_WORDS;
