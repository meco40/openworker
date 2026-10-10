//! Port of `src/server/channels/messages/sqliteMessageRepository.ts`.
//!
//! The TypeScript file is a facade over the nine query classes: it opens the
//! database, runs the migrations and forwards every method. This module keeps
//! that shape — [`MessagesStore`] owns the `Connection`, each query module is a
//! thin borrowed view over it — but Rust has no reason to keep nine long-lived
//! members, so they are constructed per call. The borrow is what a TypeScript
//! closure was doing.
//!
//! [`MessagesStore::get_conversation_context`] and
//! [`MessagesStore::upsert_conversation_context`] are the composition point for
//! the `getConversation` callback that `ContextQueries` cannot take directly; see
//! [`context`](crate::messages_store::context).
//!
//! # Which database this opens
//!
//! The constructor argument defaults to
//! `process.env.MESSAGES_DB_PATH || '.local/messages.db'`. This port resolves the
//! same two-step, but anchors the relative path at `WORKSPACE_ROOT/.local`
//! through [`db::default_db_path`] so the gateway and the scheduler agree on the
//! file when they run from different working directories.
//!
//! **`.local/messages.db` is a shared file, not a private one.** The memory,
//! knowledge, proactive and security stores each fall back to it:
//!
//! | Consumer                                      | Resolution chain                                          |
//! | --------------------------------------------- | --------------------------------------------------------- |
//! | `memory/sqliteMemoryRepository.ts:55`          | `MEMORY_DB_PATH \|\| MESSAGES_DB_PATH \|\| '.local/messages.db'` |
//! | `knowledge/sqliteKnowledgeRepository.ts:36`   | `KNOWLEDGE_DB_PATH \|\| MESSAGES_DB_PATH \|\| '.local/messages.db'` |
//! | `proactive/sqliteProactiveRepository.ts:39`    | `PROACTIVE_DB_PATH \|\| MESSAGES_DB_PATH \|\| '.local/messages.db'` |
//! | `security/status.ts:43`                        | `MESSAGES_DB_PATH \|\| '.local/messages.db'`              |
//! | `channels/credentials/credentialStore.ts:17`   | `MESSAGES_DB_PATH \|\| '.local/messages.db'`              |
//! | `agent-v2/repository/index.ts:60`              | `MESSAGES_DB_PATH \|\| '.local/messages.db'`              |
//! | `personas/personaWorkspaceMigration.ts:33`     | `MESSAGES_DB_PATH \|\| '.local/messages.db'`              |
//! | `world-model/runtime/scopeDiscovery.ts:27`     | `MESSAGES_DB_PATH \|\| resolve('.local/messages.db')`     |
//!
//! Three consequences bind this module:
//!
//! 1. It owns exactly the seven tables of its own migration and must never drop,
//!    rename or repurpose a column — the TypeScript backend and the other slices
//!    read the same file.
//! 2. It tolerates foreign tables. The migration only ever adds, the queries
//!    only ever name their own tables, and
//!    [`delete_conversation`](crate::messages_store::delete::DeleteQueries::delete_conversation)
//!    ignores failures on the S7 tables instead of requiring them.
//! 3. The `MESSAGES_DB_PATH` fallback is **not** resolved on the Rust side for
//!    those consumers yet. `MEMORY_DB_PATH`, `KNOWLEDGE_DB_PATH`,
//!    `PROACTIVE_DB_PATH` and the security/agent-v2/credential specialisations
//!    belong to S5, S7 and S12; porting them here would duplicate work that those
//!    slices own. Until they land, those stores keep running in TypeScript.

use rusqlite::Connection;

use crate::db::{default_db_path, open, OpenOptions};

use super::agent_room::AgentRoomQueries;
use super::channel_bindings::ChannelBindingQueries;
use super::context::ContextQueries;
use super::conversations::ConversationQueries;
use super::delete::DeleteQueries;
use super::inbox::InboxQueries;
use super::messages::MessageQueries;
use super::migrations::run_migrations;
use super::projects::ProjectQueries;
use super::search::SearchQueries;
use super::types::{
    AgentRoomSwarmMetrics, AgentRoomSwarmPatch, AgentRoomSwarmRecord, ChannelBinding, Conversation,
    ConversationContextState, ConversationProjectState, CreateAgentRoomSwarmInput,
    CreateConversationInput, CreateProjectInput, InboxItemRecord, InboxListInput, InboxListResult,
    MessageRepositoryError, PersonaProjectRecord, SaveMessageInput, SearchMessagesOptions,
    StoredMessage, UpsertChannelBindingInput,
};

/// SQLite-backed messages / conversations / inbox store.
pub struct MessagesStore {
    connection: Connection,
    db_path: String,
}

impl MessagesStore {
    /// `new SqliteMessageRepository(dbPath)` from `sqliteMessageRepository.ts:53`.
    pub fn open(db_path: &str) -> Result<Self, MessageRepositoryError> {
        let connection = open(OpenOptions::new(db_path))?;
        run_migrations(&connection)?;
        Ok(Self {
            connection,
            db_path: db_path.to_string(),
        })
    }

    /// Resolves `MESSAGES_DB_PATH || .local/messages.db` and opens it.
    pub fn open_default() -> Result<Self, MessageRepositoryError> {
        Self::open(&default_messages_db_path())
    }

    /// `close()` from `sqliteMessageRepository.ts:398-400`. Dropping the
    /// connection has the same effect; this exists so the lifecycle reads like the
    /// source.
    pub fn close(self) {
        drop(self.connection);
    }

    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    /// Read-only access for the migration and parity checks.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    fn conversations(&self) -> ConversationQueries<'_> {
        ConversationQueries::new(&self.connection)
    }

    fn message_queries(&self) -> MessageQueries<'_> {
        MessageQueries::new(&self.connection)
    }

    fn contexts(&self) -> ContextQueries<'_> {
        ContextQueries::new(&self.connection)
    }

    fn channel_bindings(&self) -> ChannelBindingQueries<'_> {
        ChannelBindingQueries::new(&self.connection)
    }

    fn search_queries(&self) -> SearchQueries<'_> {
        SearchQueries::new(&self.connection)
    }

    fn deletes(&self) -> DeleteQueries<'_> {
        DeleteQueries::new(&self.connection)
    }

    fn projects(&self) -> ProjectQueries<'_> {
        ProjectQueries::new(&self.connection)
    }

    fn agent_rooms(&self) -> AgentRoomQueries<'_> {
        AgentRoomQueries::new(&self.connection)
    }

    fn inbox(&self) -> InboxQueries<'_> {
        InboxQueries::new(&self.connection)
    }

    // ─── Conversations ─────────────────────────────────────────────────────

    /// `createConversation` — `sqliteMessageRepository.ts:83-85`.
    pub fn create_conversation(
        &self,
        input: &CreateConversationInput<'_>,
    ) -> Result<Conversation, MessageRepositoryError> {
        self.conversations().create_conversation(input)
    }

    /// `getConversation` — `sqliteMessageRepository.ts:87-89`.
    pub fn get_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, MessageRepositoryError> {
        self.conversations().get_conversation(id, user_id)
    }

    /// `getConversationByExternalChat` — `sqliteMessageRepository.ts:91-101`.
    pub fn get_conversation_by_external_chat(
        &self,
        channel_type: &str,
        external_chat_id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, MessageRepositoryError> {
        self.conversations().get_conversation_by_external_chat(
            channel_type,
            external_chat_id,
            user_id,
        )
    }

    /// `getOrCreateConversation` — `sqliteMessageRepository.ts:103-115`.
    pub fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, MessageRepositoryError> {
        self.conversations().get_or_create_conversation(
            channel_type,
            external_chat_id,
            title,
            user_id,
        )
    }

    /// `listConversations` — `sqliteMessageRepository.ts:117-119`.
    pub fn list_conversations(
        &self,
        limit: i64,
        user_id: Option<&str>,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        self.conversations().list_conversations(limit, user_id)
    }

    /// `listConversationsByPersona` — `sqliteMessageRepository.ts:121-123`.
    pub fn list_conversations_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        self.conversations()
            .list_conversations_by_persona(persona_id, user_id, limit)
    }

    /// `updateConversationTitle` — `sqliteMessageRepository.ts:125-127`.
    pub fn update_conversation_title(
        &self,
        id: &str,
        title: &str,
    ) -> Result<(), MessageRepositoryError> {
        self.conversations().update_conversation_title(id, title)
    }

    /// `getDefaultWebChatConversation` — `sqliteMessageRepository.ts:129-131`.
    pub fn get_default_webchat_conversation(
        &self,
        user_id: Option<&str>,
    ) -> Result<Conversation, MessageRepositoryError> {
        self.conversations()
            .get_default_webchat_conversation(user_id)
    }

    // ─── Messages ──────────────────────────────────────────────────────────

    /// `saveMessage` — `sqliteMessageRepository.ts:135-137`.
    pub fn save_message(
        &self,
        input: &SaveMessageInput<'_>,
    ) -> Result<StoredMessage, MessageRepositoryError> {
        self.message_queries().save_message(input)
    }

    /// `markMessagesMemoryPending` — `sqliteMessageRepository.ts:139-141`.
    pub fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        self.message_queries()
            .mark_messages_memory_pending(message_ids, pending, error_message)
    }

    /// `getMessage` — `sqliteMessageRepository.ts:143-145`.
    pub fn get_message(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<StoredMessage>, MessageRepositoryError> {
        self.message_queries().get_message(id, user_id)
    }

    /// `listMessages` — `sqliteMessageRepository.ts:147-155`.
    pub fn list_messages(
        &self,
        conversation_id: &str,
        limit: i64,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.message_queries()
            .list_messages(conversation_id, limit, before, user_id)
    }

    /// `listMessagesAfterSeq` — `sqliteMessageRepository.ts:157-163`.
    pub fn list_messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.message_queries()
            .list_messages_after_seq(conversation_id, after_seq, limit, user_id)
    }

    // ─── Context ───────────────────────────────────────────────────────────

    /// `getConversationContext` — `sqliteMessageRepository.ts:167-173`.
    ///
    /// An unknown or foreign conversation is `None`, exactly like the source,
    /// which returns early when `getConversation` yields nothing.
    pub fn get_conversation_context(
        &self,
        conversation_id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<ConversationContextState>, MessageRepositoryError> {
        if self.get_conversation(conversation_id, user_id)?.is_none() {
            return Ok(None);
        }
        self.contexts().get_conversation_context(conversation_id)
    }

    /// `upsertConversationContext` — `sqliteMessageRepository.ts:175-188`.
    pub fn upsert_conversation_context(
        &self,
        conversation_id: &str,
        summary_text: &str,
        summary_upto_seq: i64,
        user_id: Option<&str>,
    ) -> Result<ConversationContextState, MessageRepositoryError> {
        if self.get_conversation(conversation_id, user_id)?.is_none() {
            return Err(MessageRepositoryError::ConversationNotFoundForContext);
        }
        self.contexts()
            .upsert_conversation_context(conversation_id, summary_text, summary_upto_seq)
    }

    // ─── Delete ────────────────────────────────────────────────────────────

    /// `deleteConversation` — `sqliteMessageRepository.ts:192-198`.
    pub fn delete_conversation(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<bool, MessageRepositoryError> {
        if self.get_conversation(id, Some(user_id))?.is_none() {
            return Ok(false);
        }
        self.deletes().delete_conversation(id, user_id)
    }

    /// `deleteMessage` — `sqliteMessageRepository.ts:200-206`.
    pub fn delete_message(&self, id: &str, user_id: &str) -> Result<bool, MessageRepositoryError> {
        let Some(message) = self.get_message(id, Some(user_id))? else {
            return Ok(false);
        };
        self.deletes()
            .delete_message(id, user_id, &message.conversation_id)
    }

    // ─── Model override / persona ──────────────────────────────────────────

    /// `updateModelOverride` — `sqliteMessageRepository.ts:210-212`.
    pub fn update_model_override(
        &self,
        id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        self.conversations()
            .update_model_override(id, model_override, user_id)
    }

    /// `updatePersonaId` — `sqliteMessageRepository.ts:214-216`.
    pub fn update_persona_id(
        &self,
        id: &str,
        persona_id: Option<&str>,
        user_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        self.conversations()
            .update_persona_id(id, persona_id, user_id)
    }

    // ─── Idempotency ───────────────────────────────────────────────────────

    /// `findMessageByClientId` — `sqliteMessageRepository.ts:220-222`.
    pub fn find_message_by_client_id(
        &self,
        conversation_id: &str,
        client_message_id: &str,
    ) -> Result<Option<StoredMessage>, MessageRepositoryError> {
        self.message_queries()
            .find_message_by_client_id(conversation_id, client_message_id)
    }

    // ─── Channel bindings ──────────────────────────────────────────────────

    /// `upsertChannelBinding` — `sqliteMessageRepository.ts:226-228`.
    pub fn upsert_channel_binding(
        &self,
        input: &UpsertChannelBindingInput<'_>,
    ) -> Result<ChannelBinding, MessageRepositoryError> {
        self.channel_bindings().upsert_channel_binding(input)
    }

    /// `listChannelBindings` — `sqliteMessageRepository.ts:230-232`.
    pub fn list_channel_bindings(
        &self,
        user_id: &str,
    ) -> Result<Vec<ChannelBinding>, MessageRepositoryError> {
        self.channel_bindings().list_channel_bindings(user_id)
    }

    /// `getChannelBinding` — `sqliteMessageRepository.ts:234-238`.
    pub fn get_channel_binding(
        &self,
        user_id: &str,
        channel: &str,
    ) -> Result<Option<ChannelBinding>, MessageRepositoryError> {
        self.channel_bindings()
            .get_channel_binding(user_id, channel)
    }

    /// `updateChannelBindingPersona` — `sqliteMessageRepository.ts:240-241`.
    pub fn update_channel_binding_persona(
        &self,
        user_id: &str,
        channel: &str,
        persona_id: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        self.channel_bindings()
            .update_channel_binding_persona(user_id, channel, persona_id)
    }

    /// `touchChannelLastSeen` — `sqliteMessageRepository.ts:242-247`.
    ///
    /// `at_iso` defaults to "now" and `status` to `connected`, matching the
    /// TypeScript default parameters.
    pub fn touch_channel_last_seen(
        &self,
        user_id: &str,
        channel: &str,
        at_iso: Option<&str>,
        status: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        let now = super::types::now_iso();
        self.channel_bindings().touch_channel_last_seen(
            user_id,
            channel,
            at_iso.unwrap_or(&now),
            status.unwrap_or("connected"),
        )
    }

    // ─── Full-text search ──────────────────────────────────────────────────

    /// `searchMessages` — `sqliteMessageRepository.ts:253-255`.
    pub fn search_messages(
        &self,
        query: &str,
        options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.search_queries().search_messages(query, options)
    }

    // ─── Inbox ─────────────────────────────────────────────────────────────

    /// `listInbox` — `sqliteMessageRepository.ts:257-259`.
    pub fn list_inbox(
        &self,
        input: &InboxListInput<'_>,
    ) -> Result<InboxListResult, MessageRepositoryError> {
        self.inbox().list_inbox(input)
    }

    /// `getInboxItem` — `sqliteMessageRepository.ts:261-263`.
    pub fn get_inbox_item(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Option<InboxItemRecord>, MessageRepositoryError> {
        self.inbox().get_inbox_item(conversation_id, user_id)
    }

    // ─── Projects ──────────────────────────────────────────────────────────

    /// `createProject` — `sqliteMessageRepository.ts:265-273`.
    pub fn create_project(
        &self,
        input: &CreateProjectInput<'_>,
    ) -> Result<PersonaProjectRecord, MessageRepositoryError> {
        self.projects().create_project(input)
    }

    /// `listProjectsByPersona` — `sqliteMessageRepository.ts:275-277`.
    pub fn list_projects_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Vec<PersonaProjectRecord>, MessageRepositoryError> {
        self.projects()
            .list_projects_by_persona(persona_id, user_id)
    }

    /// `getProjectByIdOrSlug` — `sqliteMessageRepository.ts:279-281`.
    pub fn get_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<PersonaProjectRecord>, MessageRepositoryError> {
        self.projects()
            .get_project_by_id_or_slug(persona_id, user_id, id_or_slug)
    }

    /// `deleteProjectByIdOrSlug` — `sqliteMessageRepository.ts:283-285`.
    pub fn delete_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<PersonaProjectRecord>, MessageRepositoryError> {
        self.projects()
            .delete_project_by_id_or_slug(persona_id, user_id, id_or_slug)
    }

    /// `setActiveProjectForConversation` — `sqliteMessageRepository.ts:287-293`.
    pub fn set_active_project_for_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        self.projects()
            .set_active_project_for_conversation(conversation_id, user_id, project_id)
    }

    /// `getConversationProjectState` — `sqliteMessageRepository.ts:295-297`.
    pub fn get_conversation_project_state(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<ConversationProjectState, MessageRepositoryError> {
        self.projects()
            .get_conversation_project_state(conversation_id, user_id)
    }

    /// `setConversationProjectGuardApproved` — `sqliteMessageRepository.ts:299-305`.
    pub fn set_conversation_project_guard_approved(
        &self,
        conversation_id: &str,
        user_id: &str,
        approved: bool,
    ) -> Result<(), MessageRepositoryError> {
        self.projects()
            .set_conversation_project_guard_approved(conversation_id, user_id, approved)
    }

    // ─── Agent Room ────────────────────────────────────────────────────────

    /// `createAgentRoomSwarm` — `sqliteMessageRepository.ts:307-334`.
    pub fn create_agent_room_swarm(
        &self,
        input: &CreateAgentRoomSwarmInput<'_>,
    ) -> Result<AgentRoomSwarmRecord, MessageRepositoryError> {
        self.agent_rooms().create_agent_room_swarm(input)
    }

    /// `listAgentRoomSwarms` — `sqliteMessageRepository.ts:336-338`.
    pub fn list_agent_room_swarms(
        &self,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentRoomSwarmRecord>, MessageRepositoryError> {
        self.agent_rooms().list_agent_room_swarms(user_id, limit)
    }

    /// `listRunningSwarms` — `sqliteMessageRepository.ts:340-342`.
    pub fn list_running_swarms(
        &self,
        limit: i64,
    ) -> Result<Vec<AgentRoomSwarmRecord>, MessageRepositoryError> {
        self.agent_rooms().list_running_swarms(limit)
    }

    /// `recoverRunningSwarms` — `sqliteMessageRepository.ts:344-346`.
    pub fn recover_running_swarms(&self) -> Result<usize, MessageRepositoryError> {
        self.agent_rooms().recover_running_swarms()
    }

    /// `getAgentRoomSwarm` — `sqliteMessageRepository.ts:348-350`.
    pub fn get_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<AgentRoomSwarmRecord>, MessageRepositoryError> {
        self.agent_rooms().get_agent_room_swarm(id, user_id)
    }

    /// `isAgentRoomConversation` — `sqliteMessageRepository.ts:352-355`.
    pub fn is_agent_room_conversation(
        &self,
        conversation_id: &str,
        user_id: Option<&str>,
    ) -> Result<bool, MessageRepositoryError> {
        let normalized_user_id = user_id.map(|value| super::types::normalize_user_id(Some(value)));
        self.agent_rooms()
            .is_agent_room_conversation(conversation_id, normalized_user_id.as_deref())
    }

    /// `updateAgentRoomSwarm` — `sqliteMessageRepository.ts:357-388`.
    pub fn update_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
        patch: &AgentRoomSwarmPatch,
    ) -> Result<Option<AgentRoomSwarmRecord>, MessageRepositoryError> {
        self.agent_rooms()
            .update_agent_room_swarm(id, user_id, patch)
    }

    /// `deleteAgentRoomSwarm` — `sqliteMessageRepository.ts:390-392`.
    pub fn delete_agent_room_swarm(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<bool, MessageRepositoryError> {
        self.agent_rooms().delete_agent_room_swarm(id, user_id)
    }

    /// `getAgentRoomSwarmMetrics` — `sqliteMessageRepository.ts:394-396`.
    pub fn get_agent_room_swarm_metrics(
        &self,
        user_id: &str,
    ) -> Result<AgentRoomSwarmMetrics, MessageRepositoryError> {
        self.agent_rooms().get_agent_room_swarm_metrics(user_id)
    }
}

/// `MESSAGES_DB_PATH || '.local/messages.db'`, with the relative part anchored at
/// `WORKSPACE_ROOT` by [`db::default_db_path`].
/// `MESSAGES_DB_PATH || '.local/messages.db'`, with the relative part anchored at
/// `WORKSPACE_ROOT` by [`db::default_db_path`].
pub fn default_messages_db_path() -> String {
    std::env::var("MESSAGES_DB_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_db_path("messages.db"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages_store::types;
    use crate::messages_store::types::{PhaseBufferEntry, SwarmUnit};
    use serde_json::json;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-s3-{label}-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(dir: &TempDir) -> MessagesStore {
        MessagesStore::open(&dir.join("messages.db")).expect("open the store")
    }

    fn message<'a>(conversation_id: &'a str, content: &'a str) -> SaveMessageInput<'a> {
        SaveMessageInput {
            conversation_id,
            role: types::MessageRole::User,
            content,
            platform: "WebChat",
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            client_message_id: None,
        }
    }

    fn conversation(store: &MessagesStore, user_id: Option<&str>) -> Conversation {
        store
            .create_conversation(&CreateConversationInput {
                channel_type: "WebChat",
                external_chat_id: None,
                title: Some("Chat"),
                user_id,
                persona_id: None,
            })
            .expect("create conversation")
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    #[test]
    fn missing_database_is_created_with_the_full_schema() {
        let dir = TempDir::new("missing-db");
        let path = dir.join("messages.db");
        assert!(!std::path::Path::new(&path).exists());

        let store = MessagesStore::open(&path).expect("a missing file is created");

        assert!(
            std::path::Path::new(&path).exists(),
            "openSqliteDatabase creates the file"
        );
        let tables: Vec<String> = {
            let mut statement = store
                .connection()
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'table'
                       AND name NOT IN (
                         'messages_fts_config', 'messages_fts_data',
                         'messages_fts_docsize', 'messages_fts_idx'
                       )
                     ORDER BY name",
                )
                .expect("prepare");
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query")
                .collect::<Result<Vec<_>, _>>()
                .expect("rows")
        };
        assert_eq!(
            tables,
            vec![
                "agent_room_swarms",
                "channel_bindings",
                "conversation_context",
                "conversation_project_state",
                "conversations",
                "messages",
                "messages_fts",
                "persona_projects",
            ]
        );
        assert!(
            store.list_conversations(50, None).expect("list").is_empty(),
            "a fresh database has no conversations"
        );
        assert!(store
            .list_inbox(&InboxListInput {
                user_id: "u-1",
                ..Default::default()
            })
            .expect("inbox")
            .items
            .is_empty());
    }

    #[test]
    fn reopening_the_same_file_is_fresh_and_lossless() {
        let dir = TempDir::new("reopen");
        let path = dir.join("messages.db");

        let first = {
            let store = MessagesStore::open(&path).expect("open");
            let conv = conversation(&store, Some("u-1"));
            store
                .save_message(&message(&conv.id, "persisted"))
                .expect("save");
            store.close();
            conv
        };

        let store = MessagesStore::open(&path).expect("reopen");
        let messages = store
            .list_messages(&first.id, 100, None, None)
            .expect("list messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "persisted");
    }

    /// A `.local/messages.db` written by a TypeScript release from before the
    /// `user_id` / `seq` columns existed must be upgraded in place.
    #[test]
    fn upgrades_a_legacy_file_created_by_an_older_schema() {
        let dir = TempDir::new("legacy-file");
        let path = dir.join("messages.db");

        {
            let connection = crate::db::open(crate::db::OpenOptions::new(&path)).expect("open");
            connection
                .execute_batch(
                    r#"
                    CREATE TABLE conversations (
                      id TEXT PRIMARY KEY,
                      channel_type TEXT NOT NULL,
                      external_chat_id TEXT,
                      title TEXT NOT NULL DEFAULT 'Untitled',
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    );
                    CREATE TABLE messages (
                      id TEXT PRIMARY KEY,
                      conversation_id TEXT NOT NULL REFERENCES conversations(id),
                      role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
                      content TEXT NOT NULL DEFAULT '',
                      platform TEXT NOT NULL,
                      external_msg_id TEXT,
                      sender_name TEXT,
                      metadata TEXT,
                      created_at TEXT NOT NULL
                    );
                    INSERT INTO conversations (id, channel_type, title, created_at, updated_at)
                    VALUES ('c-old', 'WebChat', 'Old chat', 't0', 't0');
                    INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
                    VALUES ('m-old-1', 'c-old', 'user', 'alpha', 'WebChat', 't0');
                    INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
                    VALUES ('m-old-2', 'c-old', 'agent', 'beta', 'WebChat', 't1');
                    "#,
                )
                .expect("seed legacy file");
        }

        let store = MessagesStore::open(&path).expect("upgrade");
        let upgraded = store
            .get_conversation("c-old", None)
            .expect("read")
            .expect("the row survived");
        assert_eq!(upgraded.user_id, "legacy-local-user");
        assert_eq!(upgraded.title, "Old chat");

        let seqs: Vec<i64> = store
            .list_messages("c-old", 100, None, None)
            .expect("list")
            .into_iter()
            .map(|message| message.seq.unwrap_or_default())
            .collect();
        assert_eq!(seqs, vec![1, 2], "backfillMessageSeq numbered the rows");

        // Rows written before the triggers existed are NOT indexed.
        // `migrateFtsRebuild` (`migrations/index.ts:33-46`) guards the rebuild
        // with `SELECT COUNT(*) FROM messages_fts`, and `messages_fts` is an
        // external-content table. Per the SQLite FTS5 documentation, a query on
        // an external-content table that does not use the full-text index "is
        // effectively passed through to the external content table", so that
        // count is always the row count of `messages` itself and the guard
        // `ftsCount >= msgCount` is always true. The guard is therefore a no-op
        // in the TypeScript source as well; this port inherits that.
        assert!(
            store
                .search_messages("alpha", &SearchMessagesOptions::default())
                .expect("search")
                .is_empty(),
            "the guarded rebuild never runs, so pre-trigger rows stay unindexed"
        );

        // A row written after the triggers exist is indexed, which is what
        // keeps the store searchable end to end.
        store
            .save_message(&message("c-old", "gamma"))
            .expect("save after upgrade");
        let found = store
            .search_messages("gamma", &SearchMessagesOptions::default())
            .expect("search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "gamma");
    }

    #[test]
    fn wal_and_foreign_keys_come_from_the_shared_opener() {
        let dir = TempDir::new("pragmas");
        let store = open(&dir);

        let busy_timeout: i64 = store
            .connection()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout");
        assert_eq!(busy_timeout, 30_000);
        let journal_mode: String = store
            .connection()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode");
        assert_eq!(journal_mode, "wal");
        let foreign_keys: i64 = store
            .connection()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn a_message_for_an_unknown_conversation_is_rejected_by_the_foreign_key() {
        let dir = TempDir::new("fk");
        let store = open(&dir);
        assert!(matches!(
            store.save_message(&message("nope", "orphan")),
            Err(MessageRepositoryError::Database(_))
        ));
    }

    // ─── Conversations ─────────────────────────────────────────────────────

    #[test]
    fn creates_reads_and_updates_a_conversation() {
        let dir = TempDir::new("conversations");
        let store = open(&dir);

        let created = store
            .create_conversation(&CreateConversationInput {
                channel_type: "Telegram",
                external_chat_id: Some("chat-42"),
                title: None,
                user_id: Some("u-1"),
                persona_id: Some("p-1"),
            })
            .expect("create");
        assert_eq!(created.title, "Telegram Chat", "the derived default title");
        assert_eq!(created.channel_type, "Telegram");
        assert_eq!(created.external_chat_id.as_deref(), Some("chat-42"));
        assert_eq!(created.user_id, "u-1");
        assert_eq!(created.persona_id.as_deref(), Some("p-1"));
        assert_eq!(created.created_at, created.updated_at);

        let fetched = store
            .get_conversation(&created.id, Some("u-1"))
            .expect("read")
            .expect("present");
        assert_eq!(fetched, created);
        assert!(
            store
                .get_conversation(&created.id, Some("u-2"))
                .expect("read")
                .is_none(),
            "another user must not see it"
        );

        store
            .update_conversation_title(&created.id, "Renamed")
            .expect("rename");
        store
            .update_model_override(&created.id, Some("gemini-3-pro-preview"), "u-1")
            .expect("model override");
        store
            .update_persona_id(&created.id, Some("p-2"), "u-1")
            .expect("persona");

        let updated = store
            .get_conversation(&created.id, Some("u-1"))
            .expect("read")
            .expect("present");
        assert_eq!(updated.title, "Renamed");
        assert_eq!(
            updated.model_override.as_deref(),
            Some("gemini-3-pro-preview")
        );
        assert_eq!(updated.persona_id.as_deref(), Some("p-2"));
        assert!(updated.updated_at >= created.updated_at);
    }

    #[test]
    fn an_empty_title_falls_back_to_the_derived_default() {
        let dir = TempDir::new("title-default");
        let store = open(&dir);
        let created = store
            .create_conversation(&CreateConversationInput {
                channel_type: "Slack",
                external_chat_id: None,
                title: Some(""),
                user_id: None,
                persona_id: None,
            })
            .expect("create");
        assert_eq!(created.title, "Slack Chat");
        assert_eq!(created.user_id, "legacy-local-user");
    }

    #[test]
    fn get_or_create_reuses_the_external_chat_mapping() {
        let dir = TempDir::new("or-create");
        let store = open(&dir);

        let first = store
            .get_or_create_conversation("Telegram", "chat-7", None, Some("u-1"))
            .expect("create");
        let second = store
            .get_or_create_conversation("Telegram", "chat-7", Some("ignored"), Some("u-1"))
            .expect("reuse");
        assert_eq!(first.id, second.id);
        assert_eq!(
            store
                .get_conversation_by_external_chat("Telegram", "chat-7", Some("u-1"))
                .expect("read")
                .expect("present")
                .id,
            first.id
        );
    }

    #[test]
    fn the_default_webchat_conversation_is_a_singleton_per_user() {
        let dir = TempDir::new("default-webchat");
        let store = open(&dir);

        let first = store
            .get_default_webchat_conversation(Some("u-1"))
            .expect("create");
        let second = store
            .get_default_webchat_conversation(Some("u-1"))
            .expect("reuse");
        assert_eq!(first.id, second.id);
        assert_eq!(first.title, "WebChat");
        assert_eq!(first.external_chat_id.as_deref(), Some("default"));

        let other = store
            .get_default_webchat_conversation(Some("u-2"))
            .expect("other user");
        assert_ne!(other.id, first.id, "the default is per user");
    }

    #[test]
    fn the_inbox_hides_agent_room_conversations() {
        let dir = TempDir::new("agent-room-hidden");
        let store = open(&dir);

        let plain = conversation(&store, Some("u-1"));
        let room = store
            .create_conversation(&CreateConversationInput {
                channel_type: "AgentRoom",
                title: Some("Room"),
                user_id: Some("u-1"),
                ..Default::default()
            })
            .expect("agent room conversation");

        // A swarm hides its conversation even when the channel type is plain.
        store
            .create_agent_room_swarm(&CreateAgentRoomSwarmInput {
                conversation_id: &plain.id,
                user_id: "u-1",
                title: "Swarm",
                task: "Task",
                lead_persona_id: "p-1",
                ..Default::default()
            })
            .expect("create swarm");

        let listed = store.list_conversations(50, Some("u-1")).expect("list");
        assert!(
            listed.iter().all(|item| item.id != plain.id),
            "a conversation with a swarm is excluded: {listed:?}"
        );
        assert!(
            listed.iter().all(|item| item.id != room.id),
            "an AgentRoom channel type is excluded: {listed:?}"
        );
        assert!(
            listed.is_empty(),
            "both conversations are hidden in this fixture"
        );

        store
            .delete_agent_room_swarm(
                &store.list_agent_room_swarms("u-1", 50).expect("swarms")[0]
                    .id
                    .clone(),
                "u-1",
            )
            .expect("delete swarm");
        let after = store.list_conversations(50, Some("u-1")).expect("list");
        assert_eq!(
            after
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![plain.id.as_str()],
            "removing the swarm brings the plain conversation back"
        );
    }

    // ─── Messages ──────────────────────────────────────────────────────────

    #[test]
    fn save_message_numbers_seq_and_touches_the_conversation() {
        let dir = TempDir::new("save-message");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let before = conv.updated_at;

        let first = store
            .save_message(&message(&conv.id, "one"))
            .expect("save first");
        let second = store
            .save_message(&message(&conv.id, "two"))
            .expect("save second");

        assert_eq!(first.seq, Some(1));
        assert_eq!(second.seq, Some(2));
        assert!(first.id.starts_with("msg-"), "{}", first.id);
        assert_eq!(first.conversation_id, conv.id);
        assert_eq!(first.role, "user");
        assert_eq!(first.platform, "WebChat");

        let refreshed = store
            .get_conversation(&conv.id, Some("u-1"))
            .expect("read")
            .expect("present");
        assert!(
            refreshed.updated_at >= before,
            "saving a message bumps conversations.updated_at"
        );
    }

    #[test]
    fn save_message_is_idempotent_per_client_message_id() {
        let dir = TempDir::new("idempotency");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));

        let mut first_input = message(&conv.id, "typed once");
        first_input.client_message_id = Some("client-1");
        let first = store.save_message(&first_input).expect("save");

        let mut retry = message(&conv.id, "typed twice");
        retry.client_message_id = Some("client-1");
        let second = store.save_message(&retry).expect("save");

        assert_eq!(first.id, second.id, "the retry returns the stored row");
        assert_eq!(second.content, "typed once");
        assert_eq!(
            store
                .list_messages(&conv.id, 100, None, None)
                .expect("list")
                .len(),
            1
        );
        assert_eq!(
            store
                .find_message_by_client_id(&conv.id, "client-1")
                .expect("find")
                .expect("present")
                .id,
            first.id
        );
    }

    #[test]
    fn metadata_is_stored_as_json_text() {
        let dir = TempDir::new("metadata");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));

        let mut input = message(&conv.id, "with metadata");
        let metadata = json!({"attachments": ["a.png"], "locale": "de"});
        input.metadata = Some(&metadata);
        let saved = store.save_message(&input).expect("save");

        let stored: serde_json::Value =
            serde_json::from_str(saved.metadata.as_deref().expect("metadata")).expect("json");
        assert_eq!(stored["locale"], "de");
        assert_eq!(stored["attachments"][0], "a.png");
    }

    #[test]
    fn list_messages_pages_by_seq_and_by_created_at() {
        let dir = TempDir::new("pagination");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        for index in 1..=5 {
            store
                .save_message(&message(&conv.id, &format!("m{index}")))
                .expect("save");
        }

        let latest = store
            .list_messages(&conv.id, 2, None, None)
            .expect("latest two");
        assert_eq!(
            latest
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["m4", "m5"],
            "the window is the newest rows, still returned ascending"
        );

        let older = store
            .list_messages(&conv.id, 2, Some("4"), None)
            .expect("by seq");
        assert_eq!(
            older
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["m2", "m3"],
            "a numeric cursor is a seq bound"
        );

        let by_time = store
            .list_messages(&conv.id, 100, Some("1970-01-01T00:00:00.000Z"), None)
            .expect("by created_at");
        assert!(
            by_time.is_empty(),
            "a non-numeric cursor is a created_at bound below every stored row"
        );

        let after = store
            .list_messages_after_seq(&conv.id, 3, 500, None)
            .expect("after seq");
        assert_eq!(
            after
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["m4", "m5"]
        );
        assert!(
            store
                .list_messages_after_seq(&conv.id, -10, 500, None)
                .expect("negative seq")
                .len()
                == 5
        );
    }

    #[test]
    fn messages_are_scoped_to_the_owning_user() {
        let dir = TempDir::new("scoping");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let saved = store
            .save_message(&message(&conv.id, "private"))
            .expect("save");

        assert!(store
            .get_message(&saved.id, Some("u-1"))
            .expect("owner")
            .is_some());
        assert!(store
            .get_message(&saved.id, Some("u-2"))
            .expect("other user")
            .is_none());
        assert!(store
            .list_messages(&conv.id, 10, None, Some("u-2"))
            .expect("other user")
            .is_empty());
    }

    #[test]
    fn mark_messages_memory_pending_flips_the_metadata_flag() {
        let dir = TempDir::new("memory-pending");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));

        let mut input = message(&conv.id, "project me");
        let metadata = json!({"kind": "note"});
        input.metadata = Some(&metadata);
        let saved = store.save_message(&input).expect("save");

        store
            .mark_messages_memory_pending(&[saved.id.as_str()], true, Some("embeddings down"))
            .expect("mark pending");
        let pending: serde_json::Value = serde_json::from_str(
            store
                .get_message(&saved.id, None)
                .expect("read")
                .expect("present")
                .metadata
                .as_deref()
                .expect("metadata"),
        )
        .expect("json");
        assert_eq!(pending["memoryStatus"], "memory_pending");
        assert_eq!(pending["worldModelProjectionError"], "embeddings down");
        assert_eq!(pending["kind"], "note", "existing keys survive");

        store
            .mark_messages_memory_pending(&[saved.id.as_str()], true, Some(&"x".repeat(5000)))
            .expect("truncate");
        let truncated: serde_json::Value = serde_json::from_str(
            store
                .get_message(&saved.id, None)
                .expect("read")
                .expect("present")
                .metadata
                .as_deref()
                .expect("metadata"),
        )
        .expect("json");
        assert_eq!(
            truncated["worldModelProjectionError"]
                .as_str()
                .expect("string")
                .chars()
                .count(),
            1000,
            "the projection error is sliced to 1000 characters"
        );

        store
            .mark_messages_memory_pending(&[saved.id.as_str()], false, None)
            .expect("mark projected");
        let projected: serde_json::Value = serde_json::from_str(
            store
                .get_message(&saved.id, None)
                .expect("read")
                .expect("present")
                .metadata
                .as_deref()
                .expect("metadata"),
        )
        .expect("json");
        assert_eq!(projected["memoryStatus"], "projected");
        assert!(
            projected.get("worldModelProjectionError").is_none(),
            "the error key is deleted on success"
        );

        // Blank and duplicate ids are filtered out before the transaction runs.
        store
            .mark_messages_memory_pending(
                &["", "   ", saved.id.as_str(), saved.id.as_str()],
                true,
                None,
            )
            .expect("dedupe");
    }

    #[test]
    fn unparsable_metadata_is_preserved_under_legacy_metadata() {
        let dir = TempDir::new("legacy-metadata");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let saved = store
            .save_message(&message(&conv.id, "broken"))
            .expect("save");
        store
            .connection()
            .execute(
                "UPDATE messages SET metadata = ?1 WHERE id = ?2",
                rusqlite::params!["{not json", saved.id],
            )
            .expect("corrupt the metadata");

        store
            .mark_messages_memory_pending(&[saved.id.as_str()], true, None)
            .expect("mark pending");

        let metadata: serde_json::Value = serde_json::from_str(
            store
                .get_message(&saved.id, None)
                .expect("read")
                .expect("present")
                .metadata
                .as_deref()
                .expect("metadata"),
        )
        .expect("json");
        assert_eq!(metadata["legacyMetadata"], "{not json");
        assert_eq!(metadata["memoryStatus"], "memory_pending");
    }

    // ─── Search ────────────────────────────────────────────────────────────

    #[test]
    fn search_finds_indexed_messages_and_honours_the_filters() {
        let dir = TempDir::new("search");
        let store = open(&dir);
        let conv = store
            .create_conversation(&CreateConversationInput {
                channel_type: "WebChat",
                user_id: Some("u-1"),
                persona_id: Some("p-1"),
                ..Default::default()
            })
            .expect("conversation");

        store
            .save_message(&message(&conv.id, "The quick brown fox"))
            .expect("save");
        store
            .save_message(&message(&conv.id, "unrelated content"))
            .expect("save");

        let hits = store
            .search_messages("fox", &SearchMessagesOptions::default())
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "The quick brown fox");

        let scoped = store
            .search_messages(
                "content",
                &SearchMessagesOptions {
                    user_id: Some("u-2"),
                    ..Default::default()
                },
            )
            .expect("search other user");
        assert!(scoped.is_empty(), "the user filter applies");

        let by_conversation = store
            .search_messages(
                "fox",
                &SearchMessagesOptions {
                    conversation_id: Some("other"),
                    ..Default::default()
                },
            )
            .expect("search other conversation");
        assert!(by_conversation.is_empty());

        assert!(
            store
                .search_messages("der", &SearchMessagesOptions::default())
                .expect("stop words only")
                .is_empty(),
            "a stop-word-only query yields no MATCH expression"
        );
        assert!(
            store
                .search_messages("?!", &SearchMessagesOptions::default())
                .expect("punctuation only")
                .is_empty(),
            "punctuation-only input must not reach MATCH"
        );
    }

    #[test]
    fn the_fts_triggers_track_insert_update_and_delete() {
        let dir = TempDir::new("fts-triggers");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let saved = store
            .save_message(&message(&conv.id, "original wording"))
            .expect("save");
        assert_eq!(
            store
                .search_messages("original", &SearchMessagesOptions::default())
                .expect("search")
                .len(),
            1
        );

        store
            .connection()
            .execute(
                "UPDATE messages SET content = 'rewritten wording' WHERE id = ?1",
                rusqlite::params![saved.id],
            )
            .expect("update content");
        assert!(
            store
                .search_messages("original", &SearchMessagesOptions::default())
                .expect("search")
                .is_empty(),
            "the delete half of messages_au removes the old token"
        );
        assert_eq!(
            store
                .search_messages("rewritten", &SearchMessagesOptions::default())
                .expect("search")
                .len(),
            1
        );

        assert!(store.delete_message(&saved.id, "u-1").expect("delete"));
        assert!(
            store
                .search_messages("rewritten", &SearchMessagesOptions::default())
                .expect("search")
                .is_empty(),
            "messages_ad keeps the index in sync on delete"
        );
    }

    // ─── Inbox ─────────────────────────────────────────────────────────────

    #[test]
    fn inbox_lists_newest_first_and_pages_with_a_cursor() {
        let dir = TempDir::new("inbox");
        let store = open(&dir);

        let ids: Vec<String> = ["c-1", "c-2", "c-3"]
            .iter()
            .map(|external| {
                store
                    .create_conversation(&CreateConversationInput {
                        channel_type: "WebChat",
                        external_chat_id: Some(external),
                        title: Some(external),
                        user_id: Some("u-1"),
                        persona_id: None,
                    })
                    .expect("create")
                    .id
            })
            .collect();

        // Every `createConversation` stamps `updated_at = now`, so a tight loop
        // can give all three rows the same value; the tie-break
        // `ORDER BY c.updated_at DESC, c.id DESC` would then hand the order to
        // the random ids and the assertions below would be timing dependent.
        // Pin the timestamps so `c-1 < c-2 < c-3` is a fact, not a hope.
        let conv = store
            .get_conversation(&ids[0], Some("u-1"))
            .expect("read")
            .expect("present");
        store
            .save_message(&message(&conv.id, "latest reply"))
            .expect("save");
        for (id, updated_at) in [
            (&ids[0], "2026-05-03T00:00:00.000Z"),
            (&ids[1], "2026-05-02T00:00:00.000Z"),
            (&ids[2], "2026-05-01T00:00:00.000Z"),
        ] {
            store
                .connection()
                .execute(
                    "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
                    rusqlite::params![updated_at, id],
                )
                .expect("pin updated_at");
        }

        let page = store
            .list_inbox(&InboxListInput {
                user_id: "u-1",
                limit: Some(2),
                ..Default::default()
            })
            .expect("list");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.limit, 2);
        assert!(page.has_more, "three rows match, two were returned");
        assert_eq!(page.total_matched, 3, "the window count sees all rows");
        let cursor = page.next_cursor.clone().expect("cursor for the next page");
        assert_eq!(cursor.conversation_id, page.items[1].conversation_id);

        let last_message = page.items[0].last_message.clone().expect("last message");
        assert_eq!(last_message.content, "latest reply");
        assert_eq!(last_message.platform, "WebChat");

        let next = store
            .list_inbox(&InboxListInput {
                user_id: "u-1",
                limit: Some(2),
                cursor: Some(cursor),
                ..Default::default()
            })
            .expect("second page");
        assert_eq!(next.items.len(), 1);
        assert!(!next.has_more);
        assert!(next.next_cursor.is_none());

        let filtered = store
            .list_inbox(&InboxListInput {
                user_id: "u-1",
                query: Some("latest reply"),
                ..Default::default()
            })
            .expect("query filter");
        assert_eq!(filtered.items.len(), 1);
        assert_eq!(filtered.items[0].conversation_id, conv.id);

        let by_channel = store
            .list_inbox(&InboxListInput {
                user_id: "u-1",
                channel: Some("WEBCHAT"),
                ..Default::default()
            })
            .expect("channel filter");
        assert_eq!(
            by_channel.items.len(),
            3,
            "the channel filter is case-insensitive"
        );

        let other_user = store
            .list_inbox(&InboxListInput {
                user_id: "u-2",
                ..Default::default()
            })
            .expect("other user");
        assert!(other_user.items.is_empty());
        assert_eq!(other_user.total_matched, 0);
    }

    #[test]
    fn get_inbox_item_returns_none_for_an_unknown_or_foreign_conversation() {
        let dir = TempDir::new("inbox-item");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        store
            .save_message(&message(&conv.id, "hello"))
            .expect("save");

        let item = store
            .get_inbox_item(&conv.id, "u-1")
            .expect("read")
            .expect("present");
        assert_eq!(item.title, "Chat");
        assert_eq!(item.last_message.expect("last message").content, "hello");
        assert!(store
            .get_inbox_item(&conv.id, "u-2")
            .expect("read")
            .is_none());
        assert!(store.get_inbox_item("nope", "u-1").expect("read").is_none());
    }

    // ─── Context ───────────────────────────────────────────────────────────

    #[test]
    fn conversation_context_requires_an_existing_conversation() {
        let dir = TempDir::new("context");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));

        assert!(store
            .get_conversation_context(&conv.id, Some("u-1"))
            .expect("read")
            .is_none());

        assert!(matches!(
            store.upsert_conversation_context("nope", "summary", 1, Some("u-1")),
            Err(MessageRepositoryError::ConversationNotFoundForContext)
        ));

        let written = store
            .upsert_conversation_context(&conv.id, "summary", 7, Some("u-1"))
            .expect("upsert");
        assert_eq!(written.summary_upto_seq, 7);

        let read = store
            .get_conversation_context(&conv.id, Some("u-1"))
            .expect("read")
            .expect("present");
        assert_eq!(read.summary_text, "summary");
        assert_eq!(read.summary_upto_seq, 7);

        store
            .upsert_conversation_context(&conv.id, "updated", 9, Some("u-1"))
            .expect("second upsert");
        let updated = store
            .get_conversation_context(&conv.id, Some("u-1"))
            .expect("read")
            .expect("present");
        assert_eq!(updated.summary_text, "updated", "ON CONFLICT must upsert");
        assert_eq!(updated.summary_upto_seq, 9);

        assert!(store
            .get_conversation_context(&conv.id, Some("u-2"))
            .expect("read")
            .is_none());
    }

    // ─── Delete ────────────────────────────────────────────────────────────

    #[test]
    fn delete_conversation_removes_messages_and_derived_state() {
        let dir = TempDir::new("delete-conversation");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let saved = store.save_message(&message(&conv.id, "bye")).expect("save");
        store
            .upsert_conversation_context(&conv.id, "summary", 1, Some("u-1"))
            .expect("context");

        assert!(
            !store
                .delete_conversation(&conv.id, "u-2")
                .expect("foreign delete"),
            "a foreign user must not delete the conversation"
        );
        assert!(store.delete_conversation(&conv.id, "u-1").expect("delete"));

        assert!(store
            .get_conversation(&conv.id, None)
            .expect("read")
            .is_none());
        assert!(store.get_message(&saved.id, None).expect("read").is_none());
        assert!(store
            .get_conversation_context(&conv.id, None)
            .expect("read")
            .is_none());
        assert!(
            store
                .search_messages("bye", &SearchMessagesOptions::default())
                .expect("search")
                .is_empty(),
            "the FTS index was kept in sync by the delete trigger"
        );
    }

    #[test]
    fn delete_message_only_clears_the_runtime_context() {
        let dir = TempDir::new("delete-message");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let first = store
            .save_message(&message(&conv.id, "first"))
            .expect("save");
        store
            .save_message(&message(&conv.id, "second"))
            .expect("save");
        store
            .upsert_conversation_context(&conv.id, "summary", 2, Some("u-1"))
            .expect("context");

        assert!(!store.delete_message("nope", "u-1").expect("delete"));
        assert!(store.delete_message(&first.id, "u-1").expect("delete"));

        let remaining = store
            .list_messages(&conv.id, 100, None, None)
            .expect("list");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].content, "second");
        assert!(
            store
                .get_conversation_context(&conv.id, Some("u-1"))
                .expect("read")
                .is_none(),
            "the context cache is invalidated"
        );
    }

    // ─── Channel bindings ──────────────────────────────────────────────────

    #[test]
    fn channel_bindings_upsert_without_resetting_last_seen() {
        let dir = TempDir::new("bindings");
        let store = open(&dir);

        store
            .touch_channel_last_seen("u-1", "webchat", Some("2024-01-01T00:00:00.000Z"), None)
            .expect("touch");
        let binding = store
            .upsert_channel_binding(&UpsertChannelBindingInput {
                user_id: "u-1",
                channel: "webchat",
                status: "connected",
                external_peer_id: Some("peer-1"),
                peer_name: Some("Ada"),
                transport: Some("websocket"),
                metadata: Some(&json!({"bot": true})),
            })
            .expect("upsert");

        assert_eq!(binding.status, "connected");
        assert_eq!(binding.peer_name.as_deref(), Some("Ada"));
        assert_eq!(
            binding.last_seen_at.as_deref(),
            Some("2024-01-01T00:00:00.000Z"),
            "an explicit upsert must not touch last_seen_at"
        );
        assert!(
            binding.metadata.is_some(),
            "metadata is stored as JSON text"
        );

        store
            .update_channel_binding_persona("u-1", "webchat", Some("p-1"))
            .expect("persona");
        let updated = store
            .get_channel_binding("u-1", "webchat")
            .expect("read")
            .expect("present");
        assert_eq!(updated.persona_id.as_deref(), Some("p-1"));

        let listed = store.list_channel_bindings("u-1").expect("list");
        assert_eq!(listed.len(), 1, "upsert must not append a second row");
        assert!(store
            .get_channel_binding("u-2", "webchat")
            .expect("read")
            .is_none());
        assert!(store.list_channel_bindings("u-2").expect("list").is_empty());
    }

    // ─── Projects ──────────────────────────────────────────────────────────

    #[test]
    fn project_slugs_stay_unique_per_persona() {
        let dir = TempDir::new("projects");
        let store = open(&dir);

        let first = store
            .create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "My Project",
                workspace_path: " /workspaces/my-project ",
                workspace_relative_path: None,
            })
            .expect("create");
        assert_eq!(first.slug, "my_project");
        assert_eq!(first.workspace_path, "/workspaces/my-project");

        let second = store
            .create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "My  Project!",
                workspace_path: "/workspaces/other",
                workspace_relative_path: Some(" nested/dir "),
            })
            .expect("create");
        assert_eq!(second.slug, "my_project_2");
        assert_eq!(
            second.workspace_relative_path.as_deref(),
            Some("nested/dir")
        );

        assert!(matches!(
            store.create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: " ",
                name: "x",
                workspace_path: "/w",
                workspace_relative_path: None,
            }),
            Err(MessageRepositoryError::Validation("personaId is required"))
        ));
        assert!(matches!(
            store.create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "  ",
                workspace_path: "/w",
                workspace_relative_path: None,
            }),
            Err(MessageRepositoryError::Validation(
                "project name is required"
            ))
        ));
        assert!(matches!(
            store.create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "x",
                workspace_path: "  ",
                workspace_relative_path: None,
            }),
            Err(MessageRepositoryError::Validation(
                "workspacePath is required"
            ))
        ));

        assert_eq!(
            store
                .list_projects_by_persona("p-1", "u-1")
                .expect("list")
                .len(),
            2
        );
        assert!(store
            .get_project_by_id_or_slug("p-1", "u-1", "my_project_2")
            .expect("read by slug")
            .is_some());
        assert!(store
            .get_project_by_id_or_slug("p-1", "u-1", &second.id)
            .expect("read by id")
            .is_some());
        assert!(store
            .get_project_by_id_or_slug("p-1", "u-1", " ")
            .expect("blank lookup")
            .is_none());
        assert!(store
            .get_project_by_id_or_slug("p-2", "u-1", "my_project")
            .expect("other persona")
            .is_none());
    }

    #[test]
    fn the_project_guard_enforces_the_persona_match() {
        let dir = TempDir::new("project-guard");
        let store = open(&dir);

        let conv = store
            .create_conversation(&CreateConversationInput {
                channel_type: "WebChat",
                user_id: Some("u-1"),
                persona_id: Some("p-1"),
                ..Default::default()
            })
            .expect("conversation");
        let project = store
            .create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "Proj",
                workspace_path: "/w",
                workspace_relative_path: None,
            })
            .expect("project");

        let default_state = store
            .get_conversation_project_state(&conv.id, "u-1")
            .expect("state");
        assert!(default_state.active_project_id.is_none());
        assert!(!default_state.guard_approved_without_project);
        assert!(default_state.updated_at.is_none());

        assert!(matches!(
            store.set_active_project_for_conversation("nope", "u-1", None),
            Err(MessageRepositoryError::Validation(
                "Conversation not found."
            ))
        ));
        assert!(matches!(
            store.set_active_project_for_conversation(&conv.id, "u-1", Some("nope")),
            Err(MessageRepositoryError::Validation("Project not found."))
        ));

        store
            .set_active_project_for_conversation(&conv.id, "u-1", Some(&project.id))
            .expect("activate");
        let active = store
            .get_conversation_project_state(&conv.id, "u-1")
            .expect("state");
        assert_eq!(
            active.active_project_id.as_deref(),
            Some(project.id.as_str())
        );
        assert!(
            !active.guard_approved_without_project,
            "activating resets the guard"
        );

        store
            .set_conversation_project_guard_approved(&conv.id, "u-1", true)
            .expect("approve");
        let approved = store
            .get_conversation_project_state(&conv.id, "u-1")
            .expect("state");
        assert!(approved.guard_approved_without_project);
        assert_eq!(
            approved.active_project_id.as_deref(),
            Some(project.id.as_str()),
            "approving the guard keeps the active project"
        );

        // Deleting the project clears the conversation state in the same
        // transaction.
        let deleted = store
            .delete_project_by_id_or_slug("p-1", "u-1", &project.slug)
            .expect("delete");
        assert_eq!(deleted.expect("record").id, project.id);
        let cleared = store
            .get_conversation_project_state(&conv.id, "u-1")
            .expect("state");
        assert!(cleared.active_project_id.is_none());
        assert!(store
            .delete_project_by_id_or_slug("p-1", "u-1", "gone")
            .expect("delete missing")
            .is_none());
    }

    #[test]
    fn a_conversation_without_a_persona_cannot_activate_a_project() {
        let dir = TempDir::new("project-no-persona");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let project = store
            .create_project(&CreateProjectInput {
                user_id: "u-1",
                persona_id: "p-1",
                name: "Proj",
                workspace_path: "/w",
                workspace_relative_path: None,
            })
            .expect("project");

        assert!(matches!(
            store.set_active_project_for_conversation(&conv.id, "u-1", Some(&project.id)),
            Err(MessageRepositoryError::Validation(
                "Conversation has no active persona."
            ))
        ));
    }

    // ─── Agent Room ────────────────────────────────────────────────────────

    #[test]
    fn an_agent_room_swarm_round_trips() {
        let dir = TempDir::new("agent-room");
        let store = open(&dir);
        let conv = store
            .create_conversation(&CreateConversationInput {
                channel_type: "AgentRoom",
                user_id: Some("u-1"),
                ..Default::default()
            })
            .expect("conversation");

        let created = store
            .create_agent_room_swarm(&CreateAgentRoomSwarmInput {
                conversation_id: &conv.id,
                user_id: "u-1",
                title: "Swarm",
                task: "Ship it",
                lead_persona_id: "p-lead",
                units: vec![
                    SwarmUnit {
                        persona_id: "p-lead".into(),
                        role: "lead".into(),
                    },
                    SwarmUnit {
                        persona_id: "p-crit".into(),
                        role: "critic".into(),
                    },
                ],
                session_id: Some("s-1"),
                artifact: Some("# draft"),
                artifact_history: vec!["# v1".into()],
                last_seq: Some(12.0),
                search_enabled: Some(true),
                pause_between_phases: Some(true),
                ..Default::default()
            })
            .expect("create");

        assert_eq!(created.status, types::AgentRoomSwarmStatus::Idle);
        assert_eq!(created.current_phase, types::AgentRoomSwarmPhase::Analysis);
        assert_eq!(created.units.len(), 2);
        assert_eq!(created.artifact, "# draft");
        assert_eq!(created.artifact_history, vec!["# v1".to_string()]);
        assert_eq!(created.last_seq, 12);
        assert!(created.search_enabled);
        assert!(created.pause_between_phases);
        assert_eq!(created.friction.level, "low");
        assert!(created.phase_buffer.is_empty());
        assert!(store
            .is_agent_room_conversation(&conv.id, Some("u-1"))
            .expect("is agent room"));

        let patched = store
            .update_agent_room_swarm(
                &created.id,
                "u-1",
                &AgentRoomSwarmPatch {
                    status: Some(types::AgentRoomSwarmStatus::Running),
                    current_phase: Some(types::AgentRoomSwarmPhase::Critique),
                    phase_buffer: Some(vec![PhaseBufferEntry::Speaker {
                        persona_id: "p-crit".into(),
                    }]),
                    swarm_template: Some(Some("research".into())),
                    hold_flag: Some(true),
                    ..Default::default()
                },
            )
            .expect("update")
            .expect("still present");
        assert_eq!(patched.status, types::AgentRoomSwarmStatus::Running);
        assert_eq!(patched.current_phase, types::AgentRoomSwarmPhase::Critique);
        assert_eq!(patched.phase_buffer.len(), 1);
        assert_eq!(patched.swarm_template.as_deref(), Some("research"));
        assert!(patched.hold_flag);

        let metrics = store.get_agent_room_swarm_metrics("u-1").expect("metrics");
        assert_eq!(metrics.running_swarms, 1);
        assert_eq!(metrics.hold_swarms, 1);
        assert!(metrics.last_error_at.is_none());

        assert_eq!(store.list_running_swarms(50).expect("running").len(), 1);
        assert_eq!(store.recover_running_swarms().expect("recover"), 1);
        let recovered = store
            .get_agent_room_swarm(&created.id, "u-1")
            .expect("read")
            .expect("present");
        assert_eq!(recovered.status, types::AgentRoomSwarmStatus::Hold);

        assert!(store
            .update_agent_room_swarm("nope", "u-1", &AgentRoomSwarmPatch::default())
            .expect("update missing")
            .is_none());
        assert!(!store
            .delete_agent_room_swarm(&created.id, "u-2")
            .expect("foreign delete"));
        assert!(store
            .delete_agent_room_swarm(&created.id, "u-1")
            .expect("delete"));
        assert_eq!(
            store.list_agent_room_swarms("u-1", 50).expect("list").len(),
            0
        );
    }

    #[test]
    fn a_legacy_phase_buffer_string_is_upgraded_on_read() {
        let dir = TempDir::new("phase-buffer-legacy");
        let store = open(&dir);
        let conv = conversation(&store, Some("u-1"));
        let swarm = store
            .create_agent_room_swarm(&CreateAgentRoomSwarmInput {
                conversation_id: &conv.id,
                user_id: "u-1",
                title: "Swarm",
                task: "Task",
                lead_persona_id: "p-1",
                ..Default::default()
            })
            .expect("create");

        store
            .connection()
            .execute(
                "UPDATE agent_room_swarms SET phase_buffer_json = ?1 WHERE id = ?2",
                rusqlite::params![r#"["agentsession:p-1:s-1:5","speaker:p-2"]"#, swarm.id],
            )
            .expect("seed legacy buffer");

        let read = store
            .get_agent_room_swarm(&swarm.id, "u-1")
            .expect("read")
            .expect("present");
        assert_eq!(
            read.phase_buffer,
            vec![
                PhaseBufferEntry::AgentSession {
                    persona_id: "p-1".into(),
                    session_id: "s-1".into(),
                    last_seq: 5,
                },
                PhaseBufferEntry::Speaker {
                    persona_id: "p-2".into(),
                },
            ]
        );
    }

    // ─── Legacy user id ────────────────────────────────────────────────────

    #[test]
    fn pre_multi_tenant_rows_stay_reachable() {
        let dir = TempDir::new("legacy-user");
        let store = open(&dir);
        store
            .connection()
            .execute_batch(
                "INSERT INTO conversations (id, channel_type, user_id, title, created_at, updated_at)
                 VALUES ('c-legacy', 'WebChat', 'legacy-local-user', 'Old', 't0', 't0');",
            )
            .expect("seed");

        // No user id at all resolves to the same legacy constant.
        assert!(store
            .get_conversation("c-legacy", None)
            .expect("read")
            .is_some());
        assert!(store
            .get_conversation("c-legacy", Some(""))
            .expect("read")
            .is_some());
        assert_eq!(
            store
                .list_inbox(&InboxListInput {
                    user_id: "",
                    ..Default::default()
                })
                .expect("inbox")
                .items
                .len(),
            1,
            "the legacy inbox is not empty after the multi-tenant migration"
        );
    }
}
