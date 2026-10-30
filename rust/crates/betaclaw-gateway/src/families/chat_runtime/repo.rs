//! The messages store behind the repository and session ports.
//!
//! Port of `src/server/channels/messages/sqliteMessageRepository.ts` (through
//! `betaclaw_core::messages_store::MessagesStore`) and of `sessionManager.ts`.

use std::sync::{Arc, Mutex, PoisonError};

use betaclaw_core::channels::messages::service::conversation::ports::{
    MessageRepositoryPort, NewMessage, SessionPort,
};
use betaclaw_core::channels::messages::service::execution::ports::{PortError, PortResult};
use betaclaw_core::channels::messages::service::ports::{
    ConversationContext, NewConversation, NewProject, ProjectRecord, ProjectState,
};
use betaclaw_core::channels::pairing::credentials::{ChannelCredential, ChannelCredentialStore};
use betaclaw_core::knowledge::ingestion::types::MessageMemoryMarker;
use betaclaw_core::knowledge::ingestion_cursor::IngestionMessageSource;
use betaclaw_core::messages_store::types::{
    now_iso, ChannelBinding, ChannelType, Conversation, CreateConversationInput,
    CreateProjectInput, InboxItemRecord, InboxListInput, InboxListResult, MessageRepositoryError,
    MessageRole, PersonaProjectRecord, SaveMessageInput, StoredMessage,
};
use betaclaw_core::messages_store::MessagesStore;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::{failed, to_i64};

/// `MessagesStore` behind a std mutex. The store is synchronous, so no lock is held across an await.
pub struct MessagesRepo {
    store: Mutex<MessagesStore>,
}

impl MessagesRepo {
    pub fn open(db_path: &str) -> Result<Self, MessageRepositoryError> {
        Ok(Self {
            store: Mutex::new(MessagesStore::open(db_path)?),
        })
    }

    /// Runs `operation` on the store and keeps the store's own result type.
    pub(crate) fn with_store<T>(&self, operation: impl FnOnce(&MessagesStore) -> T) -> T {
        let guard = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        operation(&guard)
    }

    /// Runs `operation` on the store and maps its error to a port error.
    pub(crate) fn run<T>(
        &self,
        operation: impl FnOnce(&MessagesStore) -> Result<T, MessageRepositoryError>,
    ) -> PortResult<T> {
        let guard = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        operation(&guard).map_err(failed)
    }
}

/// `limit` as the store takes it, with the TypeScript default when the caller gave none.
fn limit_or(limit: Option<usize>, default: i64) -> i64 {
    limit.map_or(default, to_i64)
}

fn message_role(role: &str) -> Result<MessageRole, PortError> {
    match role {
        "user" => Ok(MessageRole::User),
        "agent" => Ok(MessageRole::Agent),
        "system" => Ok(MessageRole::System),
        other => Err(PortError::Failed(format!("unknown message role: {other}"))),
    }
}

fn project_record(record: PersonaProjectRecord) -> ProjectRecord {
    ProjectRecord {
        id: record.id,
        name: record.name,
        slug: record.slug,
        workspace_path: record.workspace_path,
        workspace_relative_path: record.workspace_relative_path,
    }
}

impl MessageRepositoryPort for MessagesRepo {
    fn get_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError> {
        self.run(|s| s.get_conversation(id, user_id))
    }

    fn get_conversation_by_external_chat(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError> {
        self.run(|s| {
            s.get_conversation_by_external_chat(channel.as_str(), external_chat_id, user_id)
        })
    }

    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        self.run(|s| {
            s.get_or_create_conversation(channel.as_str(), external_chat_id, title, user_id)
        })
    }

    fn list_conversations(
        &self,
        limit: Option<usize>,
        user_id: Option<&str>,
    ) -> Result<Vec<Conversation>, PortError> {
        // sqliteMessageRepository.ts: `listConversations(limit = 50, ...)`.
        let limit = limit_or(limit, 50);
        self.run(|s| s.list_conversations(limit, user_id))
    }

    fn get_default_web_chat_conversation(
        &self,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        self.run(|s| s.get_default_webchat_conversation(user_id))
    }

    fn list_messages(
        &self,
        conversation_id: &str,
        limit: Option<usize>,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, PortError> {
        // repository.ts: `listMessages(conversationId, limit = 100, ...)`.
        let limit = limit_or(limit, 100);
        self.run(|s| s.list_messages(conversation_id, limit, before, user_id))
    }

    fn get_message(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<StoredMessage>, PortError> {
        self.run(|s| s.get_message(id, user_id))
    }

    fn save_message(&self, message: NewMessage) -> Result<StoredMessage, PortError> {
        let role = message_role(&message.role)?;
        let metadata = message.metadata.map(Value::Object);
        self.run(|s| {
            s.save_message(&SaveMessageInput {
                conversation_id: &message.conversation_id,
                role,
                content: &message.content,
                platform: message.platform.as_str(),
                external_msg_id: None,
                sender_name: None,
                metadata: metadata.as_ref(),
                client_message_id: None,
            })
        })
    }

    fn delete_message(&self, id: &str, user_id: &str) -> Result<bool, PortError> {
        self.run(|s| s.delete_message(id, user_id))
    }

    fn delete_conversation(&self, id: &str, user_id: &str) -> Result<bool, PortError> {
        self.run(|s| s.delete_conversation(id, user_id))
    }

    fn update_persona_id(
        &self,
        id: &str,
        persona_id: Option<&str>,
        user_id: &str,
    ) -> Result<(), PortError> {
        self.run(|s| s.update_persona_id(id, persona_id, user_id))
    }

    fn is_agent_room_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<bool, PortError> {
        self.run(|s| s.is_agent_room_conversation(id, user_id))
    }

    fn get_channel_binding(
        &self,
        user_id: &str,
        channel: ChannelType,
    ) -> Result<Option<ChannelBinding>, PortError> {
        self.run(|s| s.get_channel_binding(user_id, channel.as_str()))
    }

    fn update_channel_binding_persona(
        &self,
        user_id: &str,
        channel: ChannelType,
        persona_id: Option<&str>,
    ) -> Result<(), PortError> {
        self.run(|s| s.update_channel_binding_persona(user_id, channel.as_str(), persona_id))
    }

    fn create_conversation(&self, input: &NewConversation) -> Result<Conversation, PortError> {
        self.run(|s| {
            s.create_conversation(&CreateConversationInput {
                channel_type: input.channel_type.as_str(),
                external_chat_id: input.external_chat_id.as_deref(),
                title: input.title.as_deref(),
                user_id: input.user_id.as_deref(),
                persona_id: None,
            })
        })
    }

    fn update_model_override(
        &self,
        id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), PortError> {
        self.run(|s| s.update_model_override(id, model_override, user_id))
    }

    fn get_conversation_context(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<ConversationContext>, PortError> {
        Ok(self
            .run(|s| s.get_conversation_context(id, Some(user_id)))?
            .map(|state| ConversationContext {
                summary_text: state.summary_text,
                summary_upto_seq: state.summary_upto_seq,
            }))
    }

    fn upsert_conversation_context(
        &self,
        id: &str,
        summary_text: &str,
        upto_seq: i64,
        user_id: &str,
    ) -> Result<(), PortError> {
        self.run(|s| s.upsert_conversation_context(id, summary_text, upto_seq, Some(user_id)))
            .map(|_| ())
    }

    fn get_conversation_project_state(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<ProjectState, PortError> {
        self.run(|s| s.get_conversation_project_state(id, user_id))
            .map(|state| ProjectState {
                active_project_id: state.active_project_id,
                guard_approved_without_project: state.guard_approved_without_project,
            })
    }

    fn set_conversation_project_guard_approved(
        &self,
        id: &str,
        user_id: &str,
        approved: bool,
    ) -> Result<(), PortError> {
        self.run(|s| s.set_conversation_project_guard_approved(id, user_id, approved))
    }

    fn create_project(&self, input: &NewProject) -> Result<ProjectRecord, PortError> {
        self.run(|s| {
            s.create_project(&CreateProjectInput {
                user_id: &input.user_id,
                persona_id: &input.persona_id,
                name: &input.name,
                workspace_path: &input.workspace_path,
                workspace_relative_path: input.workspace_relative_path.as_deref(),
            })
        })
        .map(project_record)
    }

    fn list_projects_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Vec<ProjectRecord>, PortError> {
        self.run(|s| s.list_projects_by_persona(persona_id, user_id))
            .map(|rows| rows.into_iter().map(project_record).collect())
    }

    fn get_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError> {
        self.run(|s| s.get_project_by_id_or_slug(persona_id, user_id, id_or_slug))
            .map(|row| row.map(project_record))
    }

    fn delete_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError> {
        self.run(|s| s.delete_project_by_id_or_slug(persona_id, user_id, id_or_slug))
            .map(|row| row.map(project_record))
    }

    fn set_active_project_for_conversation(
        &self,
        id: &str,
        user_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), PortError> {
        self.run(|s| s.set_active_project_for_conversation(id, user_id, project_id))
    }

    fn list_inbox(&self, input: &InboxListInput<'_>) -> Result<InboxListResult, PortError> {
        self.run(|s| s.list_inbox(input))
    }

    fn get_inbox_item(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<InboxItemRecord>, PortError> {
        self.run(|s| s.get_inbox_item(id, user_id))
    }
}

/// The `channel_credentials` table of the messages database: the tokens the channel senders
/// read (`credentialStore.ts`). The statements are those of the gateway's channel family,
/// which keeps its own private store over the same table.
impl ChannelCredentialStore for MessagesRepo {
    fn get_credential(&self, channel: &str, key: &str) -> Option<String> {
        self.with_store(|store| {
            store
                .connection()
                .query_row(
                    "SELECT value FROM channel_credentials WHERE channel = ?1 AND key = ?2",
                    params![channel, key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "channel credential read failed");
            None
        })
    }

    fn set_credential(&self, channel: &str, key: &str, value: &str) {
        let now = now_iso();
        let result = self.with_store(|store| {
            store.connection().execute(
                "INSERT INTO channel_credentials (channel, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(channel, key) DO UPDATE SET
                     value = excluded.value, updated_at = excluded.updated_at",
                params![channel, key, value, now],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential write failed");
        }
    }

    fn delete_credential(&self, channel: &str, key: &str) {
        let result = self.with_store(|store| {
            store.connection().execute(
                "DELETE FROM channel_credentials WHERE channel = ?1 AND key = ?2",
                params![channel, key],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential delete failed");
        }
    }

    fn delete_credentials(&self, channel: &str) {
        let result = self.with_store(|store| {
            store.connection().execute(
                "DELETE FROM channel_credentials WHERE channel = ?1",
                params![channel],
            )
        });
        if let Err(error) = result {
            tracing::warn!(%error, "channel credential delete failed");
        }
    }

    fn list_credentials(&self, channel: &str) -> Vec<ChannelCredential> {
        self.with_store(|store| -> rusqlite::Result<Vec<ChannelCredential>> {
            let mut statement = store.connection().prepare(
                "SELECT channel, key, value, updated_at FROM channel_credentials
                 WHERE channel = ?1 ORDER BY key",
            )?;
            let rows = statement.query_map(params![channel], |row| {
                Ok(ChannelCredential {
                    channel: row.get(0)?,
                    key: row.get(1)?,
                    value: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?;
            rows.collect()
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "channel credential list failed");
            Vec::new()
        })
    }
}

impl IngestionMessageSource for MessagesRepo {
    fn conversations_for_ingestion(
        &self,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        self.with_store(|s| s.list_conversations(limit, None))
    }

    fn messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.with_store(|s| {
            s.list_messages_after_seq(conversation_id, after_seq, limit, Some(user_id))
        })
    }
}

/// Shared handle to [`MessagesRepo`] that implements [`MessageMemoryMarker`].
#[derive(Clone)]
pub struct SharedMessagesRepo(pub Arc<MessagesRepo>);

impl MessageMemoryMarker for SharedMessagesRepo {
    fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        self.0
            .with_store(|s| s.mark_messages_memory_pending(message_ids, pending, error_message))
    }
}

/// `sessionManager.ts`: user resolution and conversation lookup for the web chat and the channels.
pub struct SessionManager {
    repo: Arc<MessagesRepo>,
}

impl SessionManager {
    pub fn new(repo: Arc<MessagesRepo>) -> Self {
        Self { repo }
    }
}

impl SessionPort for SessionManager {
    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        let user_id = self.resolve_user_id(user_id);
        self.repo.run(|s| {
            s.get_or_create_conversation(channel.as_str(), external_chat_id, title, Some(&user_id))
        })
    }

    fn resolve_conversation_for_web_chat(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Conversation, PortError> {
        let user_id = self.resolve_user_id(Some(user_id));
        if conversation_id.is_empty() {
            return self
                .repo
                .run(|s| s.get_default_webchat_conversation(Some(user_id.as_str())));
        }
        self.repo
            .run(|s| s.get_conversation(conversation_id, Some(user_id.as_str())))?
            .ok_or_else(|| {
                PortError::Failed("Conversation not found for current user.".to_string())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;

    #[test]
    fn conversations_are_found_again_and_scoped_to_their_user() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let session = SessionManager::new(repo.clone());

        let first = session
            .get_or_create_conversation(ChannelType::WebChat, "web-1", None, Some("user-1"))
            .expect("create");
        let again = session
            .get_or_create_conversation(ChannelType::WebChat, "web-1", None, Some("user-1"))
            .expect("find");
        assert_eq!(first.id, again.id);

        let found = session
            .resolve_conversation_for_web_chat(&first.id, "user-1")
            .expect("owner resolves");
        assert_eq!(found.id, first.id);

        let foreign = session.resolve_conversation_for_web_chat(&first.id, "user-2");
        assert_eq!(
            foreign,
            Err(PortError::Failed(
                "Conversation not found for current user.".to_string()
            ))
        );
    }

    #[test]
    fn unknown_message_roles_are_refused() {
        assert!(message_role("bot").is_err());
        assert!(matches!(message_role("agent"), Ok(MessageRole::Agent)));
    }
}
