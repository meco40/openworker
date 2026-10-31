//! Port of `src/server/knowledge/eventDedup.ts` (1-65).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `DeduplicationResult` (`:7-14`) | [`DeduplicationResult`], [`DeduplicationAction`] |
//! | `EventLookup` (`:16-23`, the minimal repository) | [`EventLookup`] |
//! | `deduplicateEvent` (`:34-65`) | [`deduplicate_event`] |
//!
//! # Deviation
//!
//! The TypeScript `findOverlappingEvents` returns `{ id, sourceSeqJson }`. The
//! port returns the full [`KnowledgeEvent`] row, which has both fields. The
//! blanket implementation makes every [`KnowledgeRepository`] an [`EventLookup`],
//! so callers pass the repository directly.

use crate::knowledge::event_extractor::ExtractedEvent;
use crate::knowledge::event_types::{KnowledgeEvent, KnowledgeEventFilter};
use crate::knowledge::repository::{KnowledgeError, KnowledgeRepository};

/// The minimal repository the dedup function needs (`eventDedup.ts:16-23`).
pub trait EventLookup {
    /// Events with the same type, counterpart and speaker that overlap the
    /// filter's date range, most recent start first.
    fn find_overlapping_events(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError>;

    /// Adds source sequence numbers to an existing event.
    fn append_event_sources(
        &self,
        event_id: &str,
        new_seqs: &[i64],
        new_summary: Option<&str>,
    ) -> Result<(), KnowledgeError>;
}

impl<R: KnowledgeRepository + ?Sized> EventLookup for R {
    fn find_overlapping_events(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError> {
        KnowledgeRepository::find_overlapping_events(self, filter)
    }

    fn append_event_sources(
        &self,
        event_id: &str,
        new_seqs: &[i64],
        new_summary: Option<&str>,
    ) -> Result<(), KnowledgeError> {
        KnowledgeRepository::append_event_sources(self, event_id, new_seqs, new_summary)
    }
}

/// `action` of `DeduplicationResult` (`eventDedup.ts:11-14`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeduplicationAction {
    /// No overlap: the caller stores the event with `upsert_event`.
    New,
    /// Overlap: sources were appended to [`DeduplicationResult::merged_into_id`].
    Merge,
    /// A confirmation of an existing event: stored separately, never merged.
    Confirmation,
}

/// `DeduplicationResult` (`eventDedup.ts:11-14`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeduplicationResult {
    pub action: DeduplicationAction,
    pub merged_into_id: Option<String>,
}

/// The `{ userId, personaId }` scope argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DedupScope<'a> {
    pub user_id: &'a str,
    pub persona_id: &'a str,
}

/// `deduplicateEvent` (`eventDedup.ts:34-65`).
///
/// 1. A confirmation returns [`DeduplicationAction::Confirmation`] without a lookup.
/// 2. Otherwise the overlapping events are searched by type, counterpart,
///    speaker and date range.
/// 3. The first hit receives the new sequence numbers and is the merge target.
/// 4. No hit means [`DeduplicationAction::New`].
pub fn deduplicate_event<R: EventLookup + ?Sized>(
    extracted: &ExtractedEvent,
    scope: DedupScope<'_>,
    repo: &R,
) -> Result<DeduplicationResult, KnowledgeError> {
    if extracted.is_confirmation {
        return Ok(DeduplicationResult {
            action: DeduplicationAction::Confirmation,
            merged_into_id: None,
        });
    }

    let filter = KnowledgeEventFilter {
        user_id: scope.user_id.to_string(),
        persona_id: scope.persona_id.to_string(),
        event_type: Some(extracted.event_type.clone()),
        speaker_role: Some(extracted.speaker_role),
        subject_entity: None,
        counterpart_entity: Some(extracted.counterpart.clone()),
        relation_label: None,
        from: Some(extracted.start_date.clone()),
        to: Some(extracted.end_date.clone()),
    };

    let overlapping = repo.find_overlapping_events(&filter)?;
    let Some(target) = overlapping.first() else {
        return Ok(DeduplicationResult {
            action: DeduplicationAction::New,
            merged_into_id: None,
        });
    };

    repo.append_event_sources(&target.id, &extracted.source_seq, None)?;
    Ok(DeduplicationResult {
        action: DeduplicationAction::Merge,
        merged_into_id: Some(target.id.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::event_types::SpeakerRole;
    use std::cell::RefCell;

    /// A lookup that returns a fixed list and records appends.
    struct FakeLookup {
        overlapping: Vec<KnowledgeEvent>,
        appended: RefCell<Vec<(String, Vec<i64>)>>,
        searches: RefCell<usize>,
    }

    impl EventLookup for FakeLookup {
        fn find_overlapping_events(
            &self,
            _filter: &KnowledgeEventFilter,
        ) -> Result<Vec<KnowledgeEvent>, KnowledgeError> {
            *self.searches.borrow_mut() += 1;
            Ok(self.overlapping.clone())
        }

        fn append_event_sources(
            &self,
            event_id: &str,
            new_seqs: &[i64],
            _summary: Option<&str>,
        ) -> Result<(), KnowledgeError> {
            self.appended
                .borrow_mut()
                .push((event_id.to_string(), new_seqs.to_vec()));
            Ok(())
        }
    }

    fn extracted(is_confirmation: bool) -> ExtractedEvent {
        ExtractedEvent {
            event_type: "visit".to_string(),
            speaker_role: SpeakerRole::User,
            subject: "User".to_string(),
            counterpart: "Max".to_string(),
            relation_label: None,
            time_expression: "gestern".to_string(),
            start_date: "2026-02-10".to_string(),
            end_date: "2026-02-10".to_string(),
            day_count: 1,
            is_confirmation,
            confirmation_signals: vec![],
            source_seq: vec![7, 8],
        }
    }

    fn event(id: &str) -> KnowledgeEvent {
        KnowledgeEvent {
            id: id.to_string(),
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            conversation_id: "c".to_string(),
            event_type: "visit".to_string(),
            speaker_role: SpeakerRole::User,
            speaker_entity: "User".to_string(),
            subject_entity: "User".to_string(),
            counterpart_entity: "Max".to_string(),
            relation_label: None,
            start_date: "2026-02-10".to_string(),
            end_date: "2026-02-10".to_string(),
            day_count: 1,
            source_seq_json: "[5]".to_string(),
            source_summary: String::new(),
            is_confirmation: false,
            confidence: 0.8,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn scope() -> DedupScope<'static> {
        DedupScope {
            user_id: "u",
            persona_id: "p",
        }
    }

    #[test]
    fn a_confirmation_is_never_searched_or_merged() {
        let repo = FakeLookup {
            overlapping: vec![event("e-1")],
            appended: RefCell::new(vec![]),
            searches: RefCell::new(0),
        };
        let result = deduplicate_event(&extracted(true), scope(), &repo).expect("dedup");
        assert_eq!(result.action, DeduplicationAction::Confirmation);
        assert_eq!(*repo.searches.borrow(), 0);
        assert!(repo.appended.borrow().is_empty());
    }

    #[test]
    fn no_overlap_is_a_new_event() {
        let repo = FakeLookup {
            overlapping: vec![],
            appended: RefCell::new(vec![]),
            searches: RefCell::new(0),
        };
        let result = deduplicate_event(&extracted(false), scope(), &repo).expect("dedup");
        assert_eq!(
            result,
            DeduplicationResult {
                action: DeduplicationAction::New,
                merged_into_id: None
            }
        );
    }

    #[test]
    fn an_overlap_merges_into_the_first_hit() {
        let repo = FakeLookup {
            overlapping: vec![event("e-1"), event("e-2")],
            appended: RefCell::new(vec![]),
            searches: RefCell::new(0),
        };
        let result = deduplicate_event(&extracted(false), scope(), &repo).expect("dedup");
        assert_eq!(result.action, DeduplicationAction::Merge);
        assert_eq!(result.merged_into_id.as_deref(), Some("e-1"));
        assert_eq!(
            *repo.appended.borrow(),
            vec![("e-1".to_string(), vec![7, 8])]
        );
    }
}
