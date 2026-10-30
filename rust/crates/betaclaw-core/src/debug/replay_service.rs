//! Port of `src/server/debug/replayService.ts`.
//!
//! [`ReplayService::replay_from`] copies the history before `from_seq` into a new
//! conversation, so a debugging session can start again from that point. Kept from
//! the source:
//! - the history is read as `listMessages(id, 500)`, the newest 500 rows, and only
//!   then filtered by `seq < from_seq`. In a conversation longer than 500 messages a
//!   `from_seq` older than the newest 500 rows replays no history at all.
//! - only role, content and platform are copied. Metadata, sender name, external
//!   message id and client message id are not.
//!
//! Not ported: the `modelOverride` argument, which the source never reads ("Phase 2"),
//! and the `PromptDispatchRepository` constructor argument, which `replayFrom` never
//! uses. `replayFrom` is `async` in the source without an `await`, so it is
//! synchronous here.

use crate::messages_store::{
    CreateConversationInput, MessageRepositoryError, MessageRole, MessagesStore, SaveMessageInput,
    StoredMessage,
};

/// `listMessages(conversationId, 500)` in `replayService.ts:28`.
const HISTORY_WINDOW: i64 = 500;

/// Failures of [`ReplayService::replay_from`]. The messages are the literal texts of
/// the `throw new Error(...)` calls in the source.
#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("fromSeq must be an integer >= 1")]
    InvalidFromSeq,
    #[error("Conversation {0} not found")]
    ConversationNotFound(String),
    #[error(transparent)]
    Messages(#[from] MessageRepositoryError),
}

/// `ReplayService` (`replayService.ts:6`).
pub struct ReplayService<'a> {
    messages: &'a MessagesStore,
}

impl<'a> ReplayService<'a> {
    pub fn new(messages: &'a MessagesStore) -> Self {
        Self { messages }
    }

    /// `replayFrom` (`replayService.ts:12-53`). Returns the id of the new conversation.
    pub fn replay_from(&self, conversation_id: &str, from_seq: i64) -> Result<String, ReplayError> {
        if from_seq < 1 {
            return Err(ReplayError::InvalidFromSeq);
        }
        let original = self
            .messages
            .get_conversation(conversation_id, None)?
            .ok_or_else(|| ReplayError::ConversationNotFound(conversation_id.to_string()))?;

        let mut history: Vec<StoredMessage> = self
            .messages
            .list_messages(conversation_id, HISTORY_WINDOW, None, None)?
            .into_iter()
            .filter(|message| message.seq.is_some_and(|seq| seq < from_seq))
            .collect();
        history.sort_by_key(|message| message.seq.unwrap_or(0));

        let title = format!("[Replay from T{from_seq}] {}", original.title);
        let external_chat_id = format!("replay-{}", chrono::Utc::now().timestamp_millis());
        let replayed = self
            .messages
            .create_conversation(&CreateConversationInput {
                channel_type: &original.channel_type,
                external_chat_id: Some(&external_chat_id),
                title: Some(&title),
                user_id: Some(&original.user_id),
                persona_id: original.persona_id.as_deref(),
            })?;

        for message in &history {
            let role = MessageRole::parse(&message.role).ok_or(
                MessageRepositoryError::Validation("stored message has an unknown role"),
            )?;
            self.messages.save_message(&SaveMessageInput {
                conversation_id: &replayed.id,
                role,
                content: &message.content,
                platform: &message.platform,
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                client_message_id: None,
            })?;
        }
        Ok(replayed.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_history() -> (MessagesStore, String) {
        let store = MessagesStore::open(":memory:").expect("open");
        let conversation = store
            .create_conversation(&CreateConversationInput {
                channel_type: "WebChat",
                title: Some("Debug chat"),
                user_id: Some("u-1"),
                persona_id: Some("p-1"),
                ..Default::default()
            })
            .expect("conversation");
        let turns = [
            (MessageRole::User, "one"),
            (MessageRole::Agent, "two"),
            (MessageRole::User, "three"),
            (MessageRole::Agent, "four"),
        ];
        for (role, content) in turns {
            store
                .save_message(&SaveMessageInput {
                    conversation_id: &conversation.id,
                    role,
                    content,
                    platform: "WebChat",
                    external_msg_id: None,
                    sender_name: None,
                    metadata: None,
                    client_message_id: None,
                })
                .expect("save");
        }
        (store, conversation.id)
    }

    #[test]
    fn copies_only_the_history_before_from_seq() {
        let (store, original_id) = store_with_history();
        let replay_id = ReplayService::new(&store)
            .replay_from(&original_id, 3)
            .expect("replay");
        assert_ne!(replay_id, original_id);

        let replayed = store
            .get_conversation(&replay_id, None)
            .expect("read")
            .expect("present");
        assert_eq!(replayed.title, "[Replay from T3] Debug chat");
        assert_eq!(replayed.channel_type, "WebChat");
        assert_eq!(replayed.user_id, "u-1");
        assert_eq!(replayed.persona_id.as_deref(), Some("p-1"));
        assert!(replayed
            .external_chat_id
            .as_deref()
            .unwrap_or_default()
            .starts_with("replay-"));

        let contents: Vec<String> = store
            .list_messages(&replay_id, 10, None, None)
            .expect("list")
            .into_iter()
            .map(|message| message.content)
            .collect();
        assert_eq!(contents, vec!["one", "two"]);
    }

    #[test]
    fn rejects_a_non_positive_seq_and_an_unknown_conversation() {
        let (store, original_id) = store_with_history();
        let service = ReplayService::new(&store);
        assert!(matches!(
            service.replay_from(&original_id, 0),
            Err(ReplayError::InvalidFromSeq)
        ));
        assert!(matches!(
            service.replay_from("missing", 2),
            Err(ReplayError::ConversationNotFound(id)) if id == "missing"
        ));
    }
}
