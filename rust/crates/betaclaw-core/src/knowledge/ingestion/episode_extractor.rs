//! Port of `src/server/knowledge/ingestion/episodeExtractor.ts` (1-55).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `EpisodeInput` (`:5-14`) | [`EpisodeInput`] |
//! | `upsertEpisodeAndLedger` (`:20-55`) | [`upsert_episode_and_ledger`] |
//! | `KnowledgeRepositoryLike` (narrowed to the two methods used here, `types.ts:17-33`) | [`EpisodeLedgerStore`] |
//!
//! The narrow trait has a blanket implementation for every [`KnowledgeRepository`],
//! so the writer can be tested with a two-method fake.

use crate::knowledge::extractor::KnowledgeExtractionResult;
use crate::knowledge::ingestion::constants::DEFAULT_TOPIC_KEY;
use crate::knowledge::ingestion::quality_checks::{infer_source_end, infer_source_start};
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::repository::{
    KnowledgeError, KnowledgeRepository, UpsertKnowledgeEpisodeInput, UpsertMeetingLedgerInput,
};

/// The two writes of [`upsert_episode_and_ledger`].
pub trait EpisodeLedgerStore {
    fn upsert_episode(&self, input: &UpsertKnowledgeEpisodeInput) -> Result<(), KnowledgeError>;
    fn upsert_meeting_ledger(&self, input: &UpsertMeetingLedgerInput)
        -> Result<(), KnowledgeError>;
}

impl<R: KnowledgeRepository + ?Sized> EpisodeLedgerStore for R {
    fn upsert_episode(&self, input: &UpsertKnowledgeEpisodeInput) -> Result<(), KnowledgeError> {
        KnowledgeRepository::upsert_episode(self, input).map(|_| ())
    }

    fn upsert_meeting_ledger(
        &self,
        input: &UpsertMeetingLedgerInput,
    ) -> Result<(), KnowledgeError> {
        KnowledgeRepository::upsert_meeting_ledger(self, input).map(|_| ())
    }
}

/// `EpisodeInput` (`episodeExtractor.ts:5-14`).
#[derive(Debug, Clone)]
pub struct EpisodeInput<'a> {
    pub window: &'a IngestionWindow,
    pub extraction: &'a KnowledgeExtractionResult,
    pub facts: Vec<String>,
    pub filtered_decisions: Vec<String>,
    pub filtered_negotiated_terms: Vec<String>,
    pub filtered_open_points: Vec<String>,
    pub filtered_action_items: Vec<String>,
    pub memory_ids: Vec<String>,
}

/// `upsertEpisodeAndLedger` (`episodeExtractor.ts:20-55`): one episode and one
/// meeting ledger entry for the window.
pub fn upsert_episode_and_ledger<R: EpisodeLedgerStore + ?Sized>(
    repo: &R,
    input: &EpisodeInput<'_>,
) -> Result<(), KnowledgeError> {
    let window = input.window;
    let extraction = input.extraction;
    let ledger = &extraction.meeting_ledger;

    // `String(topicKey || '').trim() || DEFAULT_TOPIC_KEY`
    let topic_key = match ledger.topic_key.trim() {
        "" => DEFAULT_TOPIC_KEY.to_string(),
        trimmed => trimmed.to_string(),
    };
    // `window.messages[last]?.createdAt || null`
    let event_at = window
        .messages
        .last()
        .map(|message| message.created_at.clone())
        .filter(|created_at| !created_at.is_empty());

    repo.upsert_episode(&UpsertKnowledgeEpisodeInput {
        user_id: window.user_id.clone(),
        persona_id: window.persona_id.clone(),
        conversation_id: window.conversation_id.clone(),
        topic_key: topic_key.clone(),
        counterpart: ledger.counterpart.clone(),
        teaser: extraction.teaser.clone(),
        episode: extraction.episode.clone(),
        facts: input.facts.clone(),
        memory_ids: input.memory_ids.clone(),
        source_seq_start: infer_source_start(window),
        source_seq_end: infer_source_end(window),
        source_refs: ledger.source_refs.clone(),
        event_at: event_at.clone(),
    })?;

    repo.upsert_meeting_ledger(&UpsertMeetingLedgerInput {
        user_id: window.user_id.clone(),
        persona_id: window.persona_id.clone(),
        conversation_id: window.conversation_id.clone(),
        topic_key,
        counterpart: ledger.counterpart.clone(),
        event_at,
        participants: ledger.participants.clone(),
        decisions: input.filtered_decisions.clone(),
        negotiated_terms: input.filtered_negotiated_terms.clone(),
        open_points: input.filtered_open_points.clone(),
        action_items: input.filtered_action_items.clone(),
        source_refs: ledger.source_refs.clone(),
        memory_ids: input.memory_ids.clone(),
        confidence: Some(ledger.confidence),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::extractor::KnowledgeMeetingLedger;
    use crate::messages_store::StoredMessage;
    use std::cell::RefCell;

    fn message(seq: i64, created_at: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m{seq}"),
            conversation_id: "c".into(),
            seq: Some(seq),
            role: "user".into(),
            content: "Inhalt".into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: created_at.into(),
        }
    }

    fn extraction(topic_key: &str) -> KnowledgeExtractionResult {
        KnowledgeExtractionResult {
            facts: vec![],
            teaser: "t".into(),
            episode: "e".into(),
            meeting_ledger: KnowledgeMeetingLedger {
                topic_key: topic_key.into(),
                counterpart: Some("Anna".into()),
                participants: vec!["Ich".into()],
                decisions: vec![],
                negotiated_terms: vec![],
                open_points: vec![],
                action_items: vec![],
                source_refs: vec![],
                confidence: 0.4,
            },
            events: vec![],
            entities: vec![],
        }
    }

    /// Records the two writes.
    #[derive(Default)]
    struct RecordingStore {
        episodes: RefCell<Vec<UpsertKnowledgeEpisodeInput>>,
        ledgers: RefCell<Vec<UpsertMeetingLedgerInput>>,
    }

    impl EpisodeLedgerStore for RecordingStore {
        fn upsert_episode(
            &self,
            input: &UpsertKnowledgeEpisodeInput,
        ) -> Result<(), KnowledgeError> {
            self.episodes.borrow_mut().push(input.clone());
            Ok(())
        }

        fn upsert_meeting_ledger(
            &self,
            input: &UpsertMeetingLedgerInput,
        ) -> Result<(), KnowledgeError> {
            self.ledgers.borrow_mut().push(input.clone());
            Ok(())
        }
    }

    #[test]
    fn the_episode_and_ledger_share_the_window_scope_and_source_bounds() {
        let window = IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 2,
            messages: vec![
                message(1, "2026-02-10T10:00:00.000Z"),
                message(2, "2026-02-10T10:05:00.000Z"),
            ],
        };
        let extraction = extraction("  ");
        let store = RecordingStore::default();
        upsert_episode_and_ledger(
            &store,
            &EpisodeInput {
                window: &window,
                extraction: &extraction,
                facts: vec!["Fakt".into()],
                filtered_decisions: vec![],
                filtered_negotiated_terms: vec![],
                filtered_open_points: vec![],
                filtered_action_items: vec![],
                memory_ids: vec!["mem-1".into()],
            },
        )
        .expect("upsert");
        let episodes = store.episodes.borrow();
        assert_eq!(episodes.len(), 1);
        // A blank topic key falls back to the default.
        assert_eq!(episodes[0].topic_key, "general-meeting");
        assert_eq!(episodes[0].source_seq_start, 1);
        assert_eq!(episodes[0].source_seq_end, 2);
        assert_eq!(
            episodes[0].event_at.as_deref(),
            Some("2026-02-10T10:05:00.000Z")
        );
        let ledgers = store.ledgers.borrow();
        assert_eq!(ledgers[0].confidence, Some(0.4));
        assert_eq!(ledgers[0].counterpart.as_deref(), Some("Anna"));
    }
}
