//! Port of `src/server/knowledge/ingestionCursor.ts` (1-171).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `MAX_WINDOW_MESSAGES`, `MIN_WINDOW_MESSAGES`, `MAX_MIN_BATCH` (`:10-11`, `:21`) | [`MAX_WINDOW_MESSAGES`], [`MIN_WINDOW_MESSAGES`], [`MAX_MIN_BATCH`] |
//! | `KnowledgeIngestionCursorOptions` (`:13-15`) | [`KnowledgeIngestionCursorOptions`] |
//! | `clampMinMessagesPerBatch` (`:23-27`) | [`clamp_min_messages_per_batch`] |
//! | `IngestionWindow` (`:29-37`) | [`IngestionWindow`] |
//! | `getScopedCheckpoint` (`:39-53`) | [`IngestionCheckpointStore::ingestion_checkpoint`] |
//! | `resolveNextMessages` (`:55-77`) | [`KnowledgeIngestionCursor::next_messages`] |
//! | `KnowledgeIngestionCursor` (`:79-171`) | [`KnowledgeIngestionCursor`] |
//!
//! # Ports
//!
//! The cursor needs two things from the outside. Both are narrow traits, so the
//! tests do not have to implement the full repositories:
//!
//! * [`IngestionMessageSource`] is implemented for [`MessagesStore`].
//! * [`IngestionCheckpointStore`] has a blanket implementation for every
//!   [`KnowledgeRepository`].
//!
//! # Deviations
//!
//! * `getScopedCheckpoint` branches on `getter.length >= 3`, because the
//!   TypeScript repository has an older two-argument signature. The Rust
//!   repository has only the scoped form, so only that branch is ported.
//! * `resolveNextMessages` calls `repo.listMessagesAfterSeq?.()` and falls back
//!   to `listMessages` when the optional method is missing. The Rust store always
//!   has `list_messages_after_seq`, so the fallback is not ported.
//! * The minimum-batch clamp rounds with `floor`, like the TypeScript, but takes
//!   `f64` so a fractional option behaves the same way.
//! * Conversations are sorted by `Date.parse(updatedAt)`. An unparsable date is
//!   `NaN`, which the TypeScript comparator treats as equal and the port orders
//!   after every date (`total_cmp`). The port cannot panic on that input.

use std::collections::HashSet;

use crate::knowledge::persona_isolation_policy::{create_persona_isolation_policy, PersonaMessage};
use crate::knowledge::repository::{
    KnowledgeCheckpoint, KnowledgeError, KnowledgeRepository, UpsertKnowledgeCheckpointInput,
};
use crate::knowledge::retrieval::js_date_parse_millis;
use crate::memory::service::resolve_memory_scoped_user_id_for_conversation;
use crate::messages_store::{Conversation, MessageRepositoryError, MessagesStore, StoredMessage};

/// Maximum number of messages per ingestion window (`ingestionCursor.ts:10`).
pub const MAX_WINDOW_MESSAGES: usize = 30;
/// Smallest allowed batch and chunk size (`ingestionCursor.ts:11`).
pub const MIN_WINDOW_MESSAGES: usize = 1;
/// Upper bound for `minMessagesPerBatch` (`ingestionCursor.ts:21`).
pub const MAX_MIN_BATCH: usize = 200;
/// Messages loaded per conversation in one pass (`resolveNextMessages`,
/// `ingestionCursor.ts:55-77`).
const MESSAGE_LOAD_LIMIT: i64 = 2000;

/// `KnowledgeIngestionCursorOptions` (`ingestionCursor.ts:13-15`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct KnowledgeIngestionCursorOptions {
    pub min_messages_per_batch: Option<f64>,
}

/// `clampMinMessagesPerBatch` (`ingestionCursor.ts:23-27`).
pub fn clamp_min_messages_per_batch(value: Option<f64>) -> usize {
    match value {
        Some(numeric) if numeric.is_finite() => {
            let rounded = numeric.floor();
            rounded.clamp(MIN_WINDOW_MESSAGES as f64, MAX_MIN_BATCH as f64) as usize
        }
        _ => MIN_WINDOW_MESSAGES,
    }
}

/// `IngestionWindow` (`ingestionCursor.ts:29-37`).
#[derive(Debug, Clone, PartialEq)]
pub struct IngestionWindow {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    /// Never set by the cursor, as in the TypeScript.
    pub workspace_id: Option<String>,
    pub from_seq_exclusive: i64,
    pub to_seq_inclusive: i64,
    pub messages: Vec<StoredMessage>,
}

/// The message reads the cursor needs. Implemented for [`MessagesStore`].
pub trait IngestionMessageSource {
    /// `listConversations(limit)`, newest first as the store returns them.
    fn conversations_for_ingestion(
        &self,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError>;

    /// `listMessagesAfterSeq(conversationId, afterSeq, limit, userId)`.
    fn messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError>;
}

impl IngestionMessageSource for MessagesStore {
    fn conversations_for_ingestion(
        &self,
        limit: i64,
    ) -> Result<Vec<Conversation>, MessageRepositoryError> {
        self.list_conversations(limit, None)
    }

    fn messages_after_seq(
        &self,
        conversation_id: &str,
        after_seq: i64,
        limit: i64,
        user_id: &str,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        self.list_messages_after_seq(conversation_id, after_seq, limit, Some(user_id))
    }
}

/// An error of [`KnowledgeIngestionCursor::get_pending_windows`]: the message store
/// or the checkpoint store.
#[derive(Debug, thiserror::Error)]
pub enum IngestionCursorError {
    #[error(transparent)]
    Messages(#[from] MessageRepositoryError),
    #[error(transparent)]
    Checkpoint(#[from] KnowledgeError),
}

/// The checkpoint reads and writes the cursor needs.
pub trait IngestionCheckpointStore {
    /// `getIngestionCheckpoint(conversationId, userId, personaId)`.
    fn ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
    ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeError>;

    /// `upsertIngestionCheckpoint({ conversationId, userId, personaId, lastSeq })`.
    fn store_ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
        last_seq: i64,
    ) -> Result<(), KnowledgeError>;
}

impl<R: KnowledgeRepository + ?Sized> IngestionCheckpointStore for R {
    fn ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
    ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeError> {
        KnowledgeRepository::get_ingestion_checkpoint(
            self,
            conversation_id,
            user_id,
            Some(persona_id),
        )
    }

    fn store_ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
        last_seq: i64,
    ) -> Result<(), KnowledgeError> {
        KnowledgeRepository::upsert_ingestion_checkpoint(
            self,
            &UpsertKnowledgeCheckpointInput {
                conversation_id: conversation_id.to_string(),
                user_id: Some(user_id.to_string()),
                persona_id: persona_id.to_string(),
                last_seq,
            },
        )
        .map(|_| ())
    }
}

/// `Number(message.seq || 0)` for an optional sequence number.
fn seq_or(seq: Option<i64>, fallback: i64) -> i64 {
    seq.filter(|value| *value != 0).unwrap_or(fallback)
}

/// The trimmed persona id of a conversation, if it has one.
fn persona_of(conversation: &Conversation) -> Option<&str> {
    conversation
        .persona_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `Date.parse(value)` used as a sort key.
fn updated_millis(conversation: &Conversation) -> f64 {
    js_date_parse_millis(&conversation.updated_at)
}

/// `KnowledgeIngestionCursor` (`ingestionCursor.ts:79-171`).
pub struct KnowledgeIngestionCursor<'a, M: ?Sized, K: ?Sized> {
    message_source: &'a M,
    checkpoints: &'a K,
    min_messages_per_batch: usize,
}

impl<'a, M, K> KnowledgeIngestionCursor<'a, M, K>
where
    M: IngestionMessageSource + ?Sized,
    K: IngestionCheckpointStore + ?Sized,
{
    pub fn new(
        message_source: &'a M,
        checkpoints: &'a K,
        options: KnowledgeIngestionCursorOptions,
    ) -> Self {
        Self {
            message_source,
            checkpoints,
            min_messages_per_batch: clamp_min_messages_per_batch(options.min_messages_per_batch),
        }
    }

    /// `resolveNextMessages` (`ingestionCursor.ts:55-77`): messages after the
    /// checkpoint, ordered by sequence number (a missing sequence sorts as `0`).
    fn next_messages(
        &self,
        conversation: &Conversation,
        from_seq_exclusive: i64,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
        let mut messages = self.message_source.messages_after_seq(
            &conversation.id,
            from_seq_exclusive,
            MESSAGE_LOAD_LIMIT,
            &conversation.user_id,
        )?;
        messages.sort_by_key(|message| seq_or(message.seq, 0));
        Ok(messages)
    }

    /// `getPendingWindows(limitConversations = 200)` (`ingestionCursor.ts:88-165`).
    pub fn get_pending_windows(
        &self,
        limit_conversations: i64,
    ) -> Result<Vec<IngestionWindow>, IngestionCursorError> {
        let mut conversations: Vec<Conversation> = self
            .message_source
            .conversations_for_ingestion(limit_conversations)?
            .into_iter()
            .filter(|conversation| persona_of(conversation).is_some())
            .collect();
        conversations.sort_by(|a, b| updated_millis(a).total_cmp(&updated_millis(b)));

        let mut windows = Vec::new();
        for conversation in &conversations {
            let Some(persona_id) = persona_of(conversation) else {
                continue;
            };

            let checkpoint = self.checkpoints.ingestion_checkpoint(
                &conversation.id,
                &conversation.user_id,
                persona_id,
            )?;
            let from_seq = checkpoint.map(|value| value.last_seq).unwrap_or(0).max(0);
            let messages = self.next_messages(conversation, from_seq)?;
            if messages.is_empty() {
                continue;
            }

            // Persona isolation. `StoredMessage` carries no persona id, so every
            // message is untagged and always kept (see the persona policy).
            let persona_messages: Vec<PersonaMessage> = messages
                .iter()
                .map(|message| PersonaMessage {
                    id: message.id.clone(),
                    content: message.content.clone(),
                    persona_at_message: None,
                })
                .collect();
            let kept =
                create_persona_isolation_policy().filter_by_persona(&persona_messages, persona_id);
            let kept_ids: HashSet<&str> = kept.iter().map(|message| message.id.as_str()).collect();
            let isolated: Vec<StoredMessage> = messages
                .into_iter()
                .filter(|message| kept_ids.contains(message.id.as_str()))
                .collect();
            let Some(last) = isolated.last() else {
                continue;
            };
            if isolated.len() < self.min_messages_per_batch {
                continue;
            }

            let to_seq = seq_or(last.seq, from_seq);
            if to_seq <= from_seq {
                continue;
            }

            let external_chat_id = conversation
                .external_chat_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("default");
            let user_id = resolve_memory_scoped_user_id_for_conversation(
                Some(conversation.user_id.as_str()),
                Some(conversation.channel_type.as_str()),
                Some(external_chat_id),
            );

            if isolated.len() <= MAX_WINDOW_MESSAGES {
                windows.push(IngestionWindow {
                    conversation_id: conversation.id.clone(),
                    user_id,
                    persona_id: persona_id.to_string(),
                    workspace_id: None,
                    from_seq_exclusive: from_seq,
                    to_seq_inclusive: to_seq,
                    messages: isolated,
                });
                continue;
            }

            // Sub-windowing: full chunks of MAX_WINDOW_MESSAGES. The chunk size is
            // at least MIN_WINDOW_MESSAGES, so the TypeScript's rump check cannot
            // fire and is not ported.
            for start in (0..isolated.len()).step_by(MAX_WINDOW_MESSAGES) {
                let end = (start + MAX_WINDOW_MESSAGES).min(isolated.len());
                let chunk = &isolated[start..end];
                let chunk_from = if start == 0 {
                    from_seq
                } else {
                    seq_or(isolated[start - 1].seq, from_seq)
                };
                let chunk_to = seq_or(chunk[chunk.len() - 1].seq, chunk_from);
                if chunk_to <= chunk_from && start > 0 {
                    continue;
                }
                windows.push(IngestionWindow {
                    conversation_id: conversation.id.clone(),
                    user_id: user_id.clone(),
                    persona_id: persona_id.to_string(),
                    workspace_id: None,
                    from_seq_exclusive: chunk_from,
                    to_seq_inclusive: chunk_to,
                    messages: chunk.to_vec(),
                });
            }
        }

        Ok(windows)
    }

    /// `markWindowProcessed` (`ingestionCursor.ts:167-181`): the checkpoint only
    /// moves forward.
    pub fn mark_window_processed(&self, window: &IngestionWindow) -> Result<(), KnowledgeError> {
        let current = self.checkpoints.ingestion_checkpoint(
            &window.conversation_id,
            &window.user_id,
            &window.persona_id,
        )?;
        let current_seq = current.map(|value| value.last_seq).unwrap_or(0).max(0);
        let next_seq = current_seq.max(window.to_seq_inclusive);
        self.checkpoints.store_ingestion_checkpoint(
            &window.conversation_id,
            &window.user_id,
            &window.persona_id,
            next_seq,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// In-memory conversations and messages.
    struct FakeMessages {
        conversations: Vec<Conversation>,
        messages: Vec<StoredMessage>,
    }

    impl IngestionMessageSource for FakeMessages {
        fn conversations_for_ingestion(
            &self,
            _limit: i64,
        ) -> Result<Vec<Conversation>, MessageRepositoryError> {
            Ok(self.conversations.clone())
        }

        fn messages_after_seq(
            &self,
            conversation_id: &str,
            after_seq: i64,
            _limit: i64,
            _user_id: &str,
        ) -> Result<Vec<StoredMessage>, MessageRepositoryError> {
            Ok(self
                .messages
                .iter()
                .filter(|m| m.conversation_id == conversation_id && seq_or(m.seq, 0) > after_seq)
                .cloned()
                .collect())
        }
    }

    /// In-memory checkpoints keyed by conversation, user and persona.
    #[derive(Default)]
    struct FakeCheckpoints {
        seqs: RefCell<HashMap<(String, String, String), i64>>,
    }

    impl IngestionCheckpointStore for FakeCheckpoints {
        fn ingestion_checkpoint(
            &self,
            conversation_id: &str,
            user_id: &str,
            persona_id: &str,
        ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeError> {
            let key = (
                conversation_id.to_string(),
                user_id.to_string(),
                persona_id.to_string(),
            );
            Ok(self.seqs.borrow().get(&key).map(|seq| KnowledgeCheckpoint {
                conversation_id: conversation_id.to_string(),
                user_id: Some(user_id.to_string()),
                persona_id: persona_id.to_string(),
                last_seq: *seq,
                updated_at: String::new(),
            }))
        }

        fn store_ingestion_checkpoint(
            &self,
            conversation_id: &str,
            user_id: &str,
            persona_id: &str,
            last_seq: i64,
        ) -> Result<(), KnowledgeError> {
            self.seqs.borrow_mut().insert(
                (
                    conversation_id.to_string(),
                    user_id.to_string(),
                    persona_id.to_string(),
                ),
                last_seq,
            );
            Ok(())
        }
    }

    fn conversation(id: &str, persona: Option<&str>) -> Conversation {
        Conversation {
            id: id.to_string(),
            channel_type: "webchat".to_string(),
            external_chat_id: None,
            user_id: "u-1".to_string(),
            workspace_id: None,
            title: "Test".to_string(),
            model_override: None,
            persona_id: persona.map(str::to_string),
            created_at: "2026-02-01T00:00:00.000Z".to_string(),
            updated_at: "2026-02-10T00:00:00.000Z".to_string(),
        }
    }

    fn messages(conversation_id: &str, count: i64) -> Vec<StoredMessage> {
        (1..=count)
            .map(|seq| StoredMessage {
                id: format!("{conversation_id}-m{seq}"),
                conversation_id: conversation_id.to_string(),
                seq: Some(seq),
                role: "user".to_string(),
                content: format!("Nachricht Nummer {seq}"),
                platform: "webchat".to_string(),
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                created_at: "2026-02-10T00:00:00.000Z".to_string(),
            })
            .collect()
    }

    fn cursor<'a>(
        source: &'a FakeMessages,
        checkpoints: &'a FakeCheckpoints,
        min: Option<f64>,
    ) -> KnowledgeIngestionCursor<'a, FakeMessages, FakeCheckpoints> {
        KnowledgeIngestionCursor::new(
            source,
            checkpoints,
            KnowledgeIngestionCursorOptions {
                min_messages_per_batch: min,
            },
        )
    }

    #[test]
    fn the_batch_size_is_clamped_and_floored() {
        assert_eq!(clamp_min_messages_per_batch(None), 1);
        assert_eq!(clamp_min_messages_per_batch(Some(0.0)), 1);
        assert_eq!(clamp_min_messages_per_batch(Some(2.9)), 2);
        assert_eq!(clamp_min_messages_per_batch(Some(500.0)), 200);
        assert_eq!(clamp_min_messages_per_batch(Some(f64::NAN)), 1);
    }

    #[test]
    fn a_conversation_without_a_persona_is_skipped() {
        let source = FakeMessages {
            conversations: vec![conversation("c-1", None)],
            messages: messages("c-1", 3),
        };
        let checkpoints = FakeCheckpoints::default();
        let windows = cursor(&source, &checkpoints, None)
            .get_pending_windows(200)
            .expect("windows");
        assert!(windows.is_empty());
    }

    #[test]
    fn one_window_covers_the_messages_after_the_checkpoint() {
        let source = FakeMessages {
            conversations: vec![conversation("c-1", Some("p-1"))],
            messages: messages("c-1", 5),
        };
        let checkpoints = FakeCheckpoints::default();
        checkpoints
            .store_ingestion_checkpoint("c-1", "u-1", "p-1", 2)
            .expect("store");
        let windows = cursor(&source, &checkpoints, None)
            .get_pending_windows(200)
            .expect("windows");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].from_seq_exclusive, 2);
        assert_eq!(windows[0].to_seq_inclusive, 5);
        assert_eq!(windows[0].messages.len(), 3);
        assert_eq!(windows[0].user_id, "u-1");
    }

    #[test]
    fn a_batch_below_the_minimum_is_not_ingested() {
        let source = FakeMessages {
            conversations: vec![conversation("c-1", Some("p-1"))],
            messages: messages("c-1", 2),
        };
        let checkpoints = FakeCheckpoints::default();
        assert!(cursor(&source, &checkpoints, Some(3.0))
            .get_pending_windows(200)
            .expect("windows")
            .is_empty());
        assert_eq!(
            cursor(&source, &checkpoints, Some(2.0))
                .get_pending_windows(200)
                .expect("windows")
                .len(),
            1
        );
    }

    #[test]
    fn a_large_batch_is_split_into_chunks_of_thirty() {
        let source = FakeMessages {
            conversations: vec![conversation("c-1", Some("p-1"))],
            messages: messages("c-1", 35),
        };
        let checkpoints = FakeCheckpoints::default();
        let windows = cursor(&source, &checkpoints, None)
            .get_pending_windows(200)
            .expect("windows");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].messages.len(), 30);
        assert_eq!(windows[0].to_seq_inclusive, 30);
        // The second chunk starts after the last sequence of the first one.
        assert_eq!(windows[1].from_seq_exclusive, 30);
        assert_eq!(windows[1].to_seq_inclusive, 35);
        assert_eq!(windows[1].messages.len(), 5);
    }

    #[test]
    fn the_checkpoint_only_moves_forward() {
        let source = FakeMessages {
            conversations: vec![],
            messages: vec![],
        };
        let checkpoints = FakeCheckpoints::default();
        let ingestion = cursor(&source, &checkpoints, None);
        let window = IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 5,
            messages: vec![],
        };
        ingestion.mark_window_processed(&window).expect("mark");
        ingestion
            .mark_window_processed(&IngestionWindow {
                to_seq_inclusive: 3,
                ..window.clone()
            })
            .expect("mark");
        let stored = checkpoints
            .ingestion_checkpoint("c-1", "u-1", "p-1")
            .expect("read")
            .expect("checkpoint");
        assert_eq!(stored.last_seq, 5);
    }
}
