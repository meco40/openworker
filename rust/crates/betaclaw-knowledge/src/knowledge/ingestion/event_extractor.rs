//! Port of `src/server/knowledge/ingestion/eventExtractor.ts` (1-122).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `EventProcessingContext` (`:12-16`) | [`EventProcessingContext`] |
//! | `EventStorageResult` (`:18-21`) | [`EventStorageResult`] |
//! | `resolveEventTimes` (`:27-52`) | [`resolve_event_times`] |
//! | `storeEvents` (`:58-122`) | [`store_events`] |
//! | `KnowledgeRepositoryLike` event methods (`types.ts:20-27`) | [`EventWriteStore`] |
//!
//! # Deviations
//!
//! * `storeEvents` is `async` in the TypeScript and has no `await`. The port is a
//!   synchronous function.
//! * The TypeScript returns early when the repository lacks `upsertEvent`,
//!   `findOverlappingEvents` or `appendEventSources` (all optional in
//!   `KnowledgeRepositoryLike`). The port's trait always has them, so that guard
//!   is not needed.
//! * `resolveEventTimes` uses `Europe/Berlin` as the TypeScript does. The zone is
//!   resolved through `chrono-tz` (see `time_resolver.rs`).

use serde_json::to_string as json_string;

use crate::knowledge::event_dedup::{
    deduplicate_event, DedupScope, DeduplicationAction, EventLookup,
};
use crate::knowledge::event_extractor::ExtractedEvent;
use crate::knowledge::event_types::{KnowledgeEventFilter, SpeakerRole, UpsertKnowledgeEventInput};
use crate::knowledge::extractor::KnowledgeExtractionResult;
use crate::knowledge::ingestion::constants::DEFAULT_EVENT_CONFIDENCE;
use crate::knowledge::ingestion_cursor::IngestionWindow;
use crate::knowledge::repositories::now_iso;
use crate::knowledge::repository::{KnowledgeError, KnowledgeRepository};
use crate::knowledge::time_resolver::{resolve_relative_time, TimeResolutionContext};

/// The timezone `resolveEventTimes` passes (`ingestion/eventExtractor.ts:33`).
const EVENT_TIMEZONE: &str = "Europe/Berlin";

/// The write side of the event methods of `KnowledgeRepositoryLike`. It extends
/// the dedup lookup, and a blanket implementation covers every
/// [`KnowledgeRepository`].
pub trait EventWriteStore: EventLookup {
    fn upsert_event(&self, input: &UpsertKnowledgeEventInput) -> Result<(), KnowledgeError>;
}

impl<R: KnowledgeRepository + ?Sized> EventWriteStore for R {
    fn upsert_event(&self, input: &UpsertKnowledgeEventInput) -> Result<(), KnowledgeError> {
        KnowledgeRepository::upsert_event(self, input)
    }
}

/// `EventProcessingContext` (`eventExtractor.ts:12-16`).
#[derive(Debug, Clone)]
pub struct EventProcessingContext<'a> {
    pub window: &'a IngestionWindow,
    pub extraction: &'a KnowledgeExtractionResult,
    pub persona_name: String,
}

/// `EventStorageResult` (`eventExtractor.ts:18-21`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventStorageResult {
    pub stored: usize,
    pub confirmed: usize,
}

/// `resolveEventTimes(event, lastMessageTimestamp)` (`eventExtractor.ts:27-52`).
/// A relative `startDate` is resolved against the last message in Berlin time;
/// the end date follows only when the resolver gives a range.
pub fn resolve_event_times(
    event: &ExtractedEvent,
    last_message_timestamp: &str,
) -> (String, String) {
    let context = TimeResolutionContext {
        message_timestamp: last_message_timestamp.to_string(),
        user_timezone: Some(EVENT_TIMEZONE.to_string()),
    };

    let mut resolved_start = event.start_date.clone();
    let mut resolved_end = event.end_date.clone();
    if !event.start_date.is_empty() {
        if let Some(resolved) = resolve_relative_time(&event.start_date, &context) {
            resolved_start = resolved.absolute_date;
            if let Some(end) = resolved.absolute_date_end {
                resolved_end = end;
            }
        }
    }
    (resolved_start, resolved_end)
}

/// `storeEvents` (`eventExtractor.ts:58-122`): stores each event as new, counts
/// confirmations, and merges duplicates into the existing row.
pub fn store_events<R: EventWriteStore + ?Sized>(
    repo: &R,
    context: &EventProcessingContext<'_>,
) -> Result<EventStorageResult, KnowledgeError> {
    let window = context.window;
    let mut result = EventStorageResult::default();
    if context.extraction.events.is_empty() {
        return Ok(result);
    }

    let last_message_timestamp = window
        .messages
        .last()
        .map(|message| message.created_at.clone())
        .filter(|created_at| !created_at.is_empty())
        .unwrap_or_else(now_iso);

    for event in &context.extraction.events {
        let (start, end) = resolve_event_times(event, &last_message_timestamp);
        let resolved = ExtractedEvent {
            start_date: start.clone(),
            end_date: end.clone(),
            ..event.clone()
        };
        let scope = DedupScope {
            user_id: &window.user_id,
            persona_id: &window.persona_id,
        };
        let outcome = deduplicate_event(&resolved, scope, repo)?;

        match outcome.action {
            DeduplicationAction::New => {
                let speaker_entity = if event.speaker_role == SpeakerRole::Assistant {
                    window.persona_id.clone()
                } else {
                    "User".to_string()
                };
                repo.upsert_event(&UpsertKnowledgeEventInput {
                    id: crate::knowledge::create_id("kevt"),
                    user_id: window.user_id.clone(),
                    persona_id: window.persona_id.clone(),
                    conversation_id: window.conversation_id.clone(),
                    event_type: event.event_type.clone(),
                    speaker_role: event.speaker_role,
                    speaker_entity,
                    subject_entity: event.subject.clone(),
                    counterpart_entity: event.counterpart.clone(),
                    relation_label: event.relation_label.clone(),
                    start_date: start,
                    end_date: end,
                    day_count: event.day_count,
                    source_seq_json: Some(
                        json_string(&event.source_seq).unwrap_or_else(|_| "[]".to_string()),
                    ),
                    source_summary: Some(format!(
                        "{} {} with {}",
                        event.subject, event.event_type, event.counterpart
                    )),
                    is_confirmation: Some(false),
                    confidence: Some(DEFAULT_EVENT_CONFIDENCE),
                })?;
                result.stored += 1;
            }
            DeduplicationAction::Confirmation => {
                // A confirmation adds its sources to the first matching event.
                let overlapping = repo.find_overlapping_events(&KnowledgeEventFilter {
                    user_id: window.user_id.clone(),
                    persona_id: window.persona_id.clone(),
                    event_type: Some(event.event_type.clone()),
                    speaker_role: None,
                    subject_entity: None,
                    counterpart_entity: Some(event.counterpart.clone()),
                    relation_label: None,
                    from: Some(start),
                    to: Some(end),
                })?;
                if let Some(first) = overlapping.first() {
                    repo.append_event_sources(
                        &first.id,
                        &event.source_seq,
                        Some("Confirmed by user"),
                    )?;
                }
                result.confirmed += 1;
            }
            // A merge was already applied by `deduplicate_event`.
            DeduplicationAction::Merge => {}
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::event_types::KnowledgeEvent;
    use crate::messages_store::StoredMessage;
    use std::cell::RefCell;

    /// Records dedup lookups and writes; `existing` is what a lookup returns.
    #[derive(Default)]
    struct RecordingStore {
        existing: Vec<KnowledgeEvent>,
        upserts: RefCell<Vec<UpsertKnowledgeEventInput>>,
        appends: RefCell<Vec<(String, Vec<i64>)>>,
    }

    impl EventLookup for RecordingStore {
        fn find_overlapping_events(
            &self,
            _filter: &KnowledgeEventFilter,
        ) -> Result<Vec<KnowledgeEvent>, KnowledgeError> {
            Ok(self.existing.clone())
        }

        fn append_event_sources(
            &self,
            event_id: &str,
            new_seqs: &[i64],
            _summary: Option<&str>,
        ) -> Result<(), KnowledgeError> {
            self.appends
                .borrow_mut()
                .push((event_id.to_string(), new_seqs.to_vec()));
            Ok(())
        }
    }

    impl EventWriteStore for RecordingStore {
        fn upsert_event(&self, input: &UpsertKnowledgeEventInput) -> Result<(), KnowledgeError> {
            self.upserts.borrow_mut().push(input.clone());
            Ok(())
        }
    }

    fn window(created_at: &str) -> IngestionWindow {
        IngestionWindow {
            conversation_id: "c-1".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: 0,
            to_seq_inclusive: 1,
            messages: vec![StoredMessage {
                id: "m1".into(),
                conversation_id: "c-1".into(),
                seq: Some(1),
                role: "user".into(),
                content: "Wir waren gestern im Kino".into(),
                platform: "web".into(),
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                created_at: created_at.into(),
            }],
        }
    }

    fn event(time: &str, start: &str, confirmation: bool) -> ExtractedEvent {
        ExtractedEvent {
            event_type: "visit".into(),
            speaker_role: SpeakerRole::User,
            subject: "User".into(),
            counterpart: "Max".into(),
            relation_label: None,
            time_expression: time.into(),
            start_date: start.into(),
            end_date: start.into(),
            day_count: 1,
            is_confirmation: confirmation,
            confirmation_signals: vec![],
            source_seq: vec![1],
        }
    }

    fn extraction(events: Vec<ExtractedEvent>) -> KnowledgeExtractionResult {
        use crate::knowledge::extractor::KnowledgeMeetingLedger;
        KnowledgeExtractionResult {
            facts: vec![],
            teaser: String::new(),
            episode: String::new(),
            meeting_ledger: KnowledgeMeetingLedger {
                topic_key: "general-meeting".into(),
                counterpart: None,
                participants: vec![],
                decisions: vec![],
                negotiated_terms: vec![],
                open_points: vec![],
                action_items: vec![],
                source_refs: vec![],
                confidence: 0.6,
            },
            events,
            entities: vec![],
        }
    }

    #[test]
    fn a_relative_start_is_resolved_against_the_last_message_in_berlin() {
        // 2026-03-29T23:30Z is 30 March 01:30 in Berlin (summer time), so "gestern"
        // is 29 March.
        let (start, end) =
            resolve_event_times(&event("gestern", "gestern", false), "2026-03-29T23:30:00Z");
        assert_eq!(start, "2026-03-29");
        assert_eq!(end, "gestern", "the end keeps the extractor's value");
    }

    #[test]
    fn a_new_event_is_stored_with_the_speaker_entity_and_default_confidence() {
        let window = window("2026-02-11T10:00:00.000Z");
        let extraction = extraction(vec![event("", "2026-02-10", false)]);
        let store = RecordingStore::default();
        let result = store_events(
            &store,
            &EventProcessingContext {
                window: &window,
                extraction: &extraction,
                persona_name: "Nata".into(),
            },
        )
        .expect("store");
        assert_eq!(
            result,
            EventStorageResult {
                stored: 1,
                confirmed: 0
            }
        );
        let upserts = store.upserts.borrow();
        assert_eq!(upserts[0].speaker_entity, "User");
        assert_eq!(upserts[0].confidence, Some(DEFAULT_EVENT_CONFIDENCE));
        assert_eq!(upserts[0].source_seq_json.as_deref(), Some("[1]"));
    }

    #[test]
    fn an_overlapping_event_is_merged_and_a_confirmation_counts_separately() {
        let window = window("2026-02-11T10:00:00.000Z");
        let existing = vec![KnowledgeEvent {
            id: "kevt-existing".into(),
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            conversation_id: "c-1".into(),
            event_type: "visit".into(),
            speaker_role: SpeakerRole::User,
            speaker_entity: "User".into(),
            subject_entity: "User".into(),
            counterpart_entity: "Max".into(),
            relation_label: None,
            start_date: "2026-02-10".into(),
            end_date: "2026-02-10".into(),
            day_count: 1,
            source_seq_json: "[1]".into(),
            source_summary: String::new(),
            is_confirmation: false,
            confidence: 0.85,
            created_at: String::new(),
            updated_at: String::new(),
        }];
        let extraction = extraction(vec![
            event("", "2026-02-10", false),
            event("", "2026-02-10", true),
        ]);
        let store = RecordingStore {
            existing,
            ..RecordingStore::default()
        };
        let result = store_events(
            &store,
            &EventProcessingContext {
                window: &window,
                extraction: &extraction,
                persona_name: "Nata".into(),
            },
        )
        .expect("store");
        assert_eq!(
            result,
            EventStorageResult {
                stored: 0,
                confirmed: 1
            }
        );
        assert!(store.upserts.borrow().is_empty());
        // The merge and the confirmation each append their source to the existing row.
        assert_eq!(store.appends.borrow().len(), 2);
        assert_eq!(store.appends.borrow()[0].0, "kevt-existing");
    }
}
