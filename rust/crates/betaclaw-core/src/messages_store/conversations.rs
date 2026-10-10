//! Port of `src/server/channels/messages/repository/queries/conversations.ts`.
//!
//! | TypeScript member                     | Rust member                        |
//! | ------------------------------------- | ---------------------------------- |
//! | `createConversation`                  | [`ConversationQueries::create_conversation`]      |
//! | `getConversation`                     | [`ConversationQueries::get_conversation`]         |
//! | `getConversationByExternalChat`       | [`ConversationQueries::get_conversation_by_external_chat`] |
//! | `getOrCreateConversation`             | [`ConversationQueries::get_or_create_conversation`] |
//! | `listConversations`                   | [`ConversationQueries::list_conversations`]       |
//! | `listConversationsByPersona`          | [`ConversationQueries::list_conversations_by_persona`] |
//! | `updateConversationTitle`             | [`ConversationQueries::update_conversation_title`] |
//! | `getDefaultWebChatConversation`       | [`ConversationQueries::get_default_webchat_conversation`] |
//! | `updateModelOverride`                 | [`ConversationQueries::update_model_override`]    |
//! | `updatePersonaId`                     | [`ConversationQueries::update_persona_id`]        |
//!
//! The TypeScript class receives `normalizeUserId` as a constructor callback
//! bound by `SqliteMessageRepository`. The port calls the shared
//! [`normalize_user_id`](crate::messages_store::types::normalize_user_id)
//! directly, which is the same function without the closure indirection.
//!
//! `logInboxDbQuery` is ported as a [`QueryTimer`] plus
//! [`log_inbox_db_query`](crate::messages_store::trace::log_inbox_db_query).

use rusqlite::{params, Connection, OptionalExtension};

use super::row_mappers::to_conversation;
use super::trace::{log_inbox_db_query, QueryTimer};
use super::types::{
    normalize_user_id, now_iso, Conversation, CreateConversationInput, MessageRepositoryError,
};

/// `ConversationQueries` from `conversations.ts:9`.
pub struct ConversationQueries<'a> {
    db: &'a Connection,
}

impl<'a> ConversationQueries<'a> {
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// `createConversation` from `conversations.ts:15-40`.
    pub fn create_conversation(
        &self,
        input: &CreateConversationInput<'_>,
    ) -> Result<Conversation, MessageRepositoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let title = match input.title {
            Some(title) if !title.is_empty() => title.to_string(),
            _ => format!("{} Chat", input.channel_type),
        };
        let user_id = normalize_user_id(input.user_id);

        self.db.execute(
            "
            INSERT INTO conversations (id, channel_type, external_chat_id, user_id, title, persona_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ",
            params![
                id,
                input.channel_type,
                input.external_chat_id.filter(|value| !value.is_empty()),
                user_id,
                title,
                input.persona_id.filter(|value| !value.is_empty()),
                now,
                now
            ],
        )?;

        self.get_conversation(&id, Some(&user_id))?
            .ok_or(MessageRepositoryError::MissingRow {
                context: "conversations.create",
            })
    }

    /// `getConversation` from `conversations.ts:42-59`.
    pub fn get_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, MessageRepositoryError> {
        let timer = QueryTimer::start();
        let normalized_user_id = user_id.map(|value| normalize_user_id(Some(value)));

        let conversation = match normalized_user_id.as_deref() {
            Some(user_id) => self
                .db
                .query_row(
                    "SELECT * FROM conversations WHERE id = ?1 AND user_id = ?2",
                    params![id, user_id],
                    to_conversation,
                )
                .optional()?,
            None => self
                .db
                .query_row(
                    "SELECT * FROM conversations WHERE id = ?1",
                    params![id],
                    to_conversation,
                )
                .optional()?,
        };

        log_inbox_db_query("conversations.get", timer.elapsed_ms());
        tracing::debug!(
            scope = "chat.display",
            query = "conversations.get",
            conversation_id = id,
            user_id = normalized_user_id.as_deref().unwrap_or_default(),
            found = conversation.is_some(),
            "conversation lookup"
        );

        Ok(conversation)
    }

    /// `getConversationByExternalChat` from `conversations.ts:61-73`.
    pub fn get_conversation_by_external_chat(
        &self,
        channel_type: &str,
        external_chat_id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(user_id);
        self.db
            .query_row(
                "SELECT * FROM conversations WHERE channel_type = ?1 AND external_chat_id = ?2 AND user_id = ?3",
                params![channel_type, external_chat_id, normalized_user_id],
                to_conversation,
            )
            .optional()
            .map_err(Into::into)
    }

    /// `getOrCreateConversation` from `conversations.ts:75-94`.
    pub fn get_or_create_conversation(
        &self,
        channel_type: &str,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(user_id);
        if let Some(existing) = self.get_conversation_by_external_chat(
            channel_type,
            external_chat_id,
            Some(&normalized_user_id),
        )? {
            return Ok(existing);
        }
        self.create_conversation(&CreateConversationInput {
            channel_type,
            external_chat_id: Some(external_chat_id),
            title,
            user_id: Some(&normalized_user_id),
            persona_id: None,
        })
    }

    /// `listConversations` from `conversations.ts:96-142`.
    ///
    /// Excludes Agent Room conversations (including legacy variants) and any
    /// conversation linked to an Agent Room swarm.
    pub fn list_conversations(
        &self,
        limit: i64,
        user_id: Option<&str>,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        let timer = QueryTimer::start();
        let normalized_user_id = user_id.map(|value| normalize_user_id(Some(value)));

        let rows: Vec<Conversation> = match normalized_user_id.as_deref() {
            Some(user_id) => {
                let mut statement = self.db.prepare(
                    "
                    SELECT c.*
                    FROM conversations c
                    WHERE c.user_id = ?1
                      AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
                      AND NOT EXISTS (
                        SELECT 1
                        FROM agent_room_swarms s
                        WHERE s.conversation_id = c.id AND s.user_id = c.user_id
                      )
                    ORDER BY c.updated_at DESC
                    LIMIT ?2
                  ",
                )?;
                let mapped = statement.query_map(params![user_id, limit], to_conversation)?;
                mapped.collect::<Result<Vec<_>, _>>()?
            }
            None => {
                let mut statement = self.db.prepare(
                    "
                    SELECT c.*
                    FROM conversations c
                    WHERE LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
                      AND NOT EXISTS (
                        SELECT 1
                        FROM agent_room_swarms s
                        WHERE s.conversation_id = c.id
                      )
                    ORDER BY c.updated_at DESC
                    LIMIT ?1
                  ",
                )?;
                let mapped = statement.query_map(params![limit], to_conversation)?;
                mapped.collect::<Result<Vec<_>, _>>()?
            }
        };

        log_inbox_db_query("conversations.list", timer.elapsed_ms());
        Ok(rows)
    }

    /// `listConversationsByPersona` from `conversations.ts:144-152`.
    pub fn list_conversations_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        let mut statement = self.db.prepare(
            "SELECT * FROM conversations WHERE user_id = ?1 AND persona_id = ?2 ORDER BY updated_at DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![normalized_user_id, persona_id, limit],
            to_conversation,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// `updateConversationTitle` from `conversations.ts:154-159`.
    pub fn update_conversation_title(
        &self,
        id: &str,
        title: &str,
    ) -> Result<(), MessageRepositoryError> {
        self.db.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now_iso(), id],
        )?;
        Ok(())
    }

    /// `getDefaultWebChatConversation` from `conversations.ts:161-169`.
    ///
    /// `ChannelType.WEBCHAT` is the literal `'WebChat'`.
    pub fn get_default_webchat_conversation(
        &self,
        user_id: Option<&str>,
    ) -> Result<Conversation, MessageRepositoryError> {
        self.get_or_create_conversation("WebChat", "default", Some("WebChat"), user_id)
    }

    /// `updateModelOverride` from `conversations.ts:171-179`.
    pub fn update_model_override(
        &self,
        id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        self.db.execute(
            "UPDATE conversations SET model_override = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![model_override, now_iso(), id, normalized_user_id],
        )?;
        Ok(())
    }

    /// `updatePersonaId` from `conversations.ts:181-189`.
    pub fn update_persona_id(
        &self,
        id: &str,
        persona_id: Option<&str>,
        user_id: &str,
    ) -> Result<(), MessageRepositoryError> {
        let normalized_user_id = normalize_user_id(Some(user_id));
        self.db.execute(
            "UPDATE conversations SET persona_id = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4",
            params![persona_id, now_iso(), id, normalized_user_id],
        )?;
        Ok(())
    }
}
