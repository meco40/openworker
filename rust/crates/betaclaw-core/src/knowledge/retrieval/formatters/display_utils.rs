//! Port of `src/server/knowledge/retrieval/formatters/displayUtils.ts` (1-25).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `formatters/displayUtils.ts:4-8` (`toDisplayName`)    | [`to_display_name`] |
//! | `formatters/displayUtils.ts:10-19` (`selectConversationId`) | [`select_conversation_id`] |
//! | `formatters/displayUtils.ts:21-25` (`isCounterpartMatch`) | [`is_counterpart_match`] |
//!
//! `isCounterpartMatch` is byte-for-byte the same function as
//! `query/intentDetector.ts:51-55`; the port keeps the single implementation in
//! [`crate::knowledge::retrieval::query::intent_detector`] and wraps it here for
//! the nullable value the source takes (`String(value || '')`).
//!
//! `charAt(0)` reads the first UTF-16 code unit; the port uppercases the first
//! `char`. Every counterpart is a stored name, so the two agree.

use crate::knowledge::repository::{KnowledgeEpisode, MeetingLedgerEntry};
use crate::knowledge::retrieval::query::intent_detector::is_counterpart_match as detector_match;

/// `toDisplayName` from `formatters/displayUtils.ts:4-8`.
pub fn to_display_name(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or("").trim();
    if normalized.is_empty() {
        return None;
    }
    let mut chars = normalized.chars();
    let first = chars.next().expect("non-empty");
    let rest = chars.as_str();
    Some(format!("{}{}", first.to_uppercase(), rest))
}

/// `selectConversationId` from `formatters/displayUtils.ts:10-19`.
pub fn select_conversation_id(
    episodes: &[KnowledgeEpisode],
    ledger_rows: &[MeetingLedgerEntry],
) -> Option<String> {
    if let Some(row) = ledger_rows.first() {
        let from_ledger = row.conversation_id.trim();
        if !from_ledger.is_empty() {
            return Some(from_ledger.to_string());
        }
    }
    if let Some(row) = episodes.first() {
        let from_episodes = row.conversation_id.trim();
        if !from_episodes.is_empty() {
            return Some(from_episodes.to_string());
        }
    }
    None
}

/// `isCounterpartMatch` from `formatters/displayUtils.ts:21-25`.
pub fn is_counterpart_match(value: Option<&str>, counterpart: &str) -> bool {
    detector_match(value.unwrap_or(""), counterpart)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_display_name_uppercases_the_first_letter_only() {
        assert_eq!(
            to_display_name(Some(" max mustermann ")),
            Some("Max mustermann".to_string())
        );
        assert_eq!(to_display_name(Some("Ärmel")), Some("Ärmel".to_string()));
        assert_eq!(to_display_name(None), None);
        assert_eq!(to_display_name(Some("   ")), None);
    }

    #[test]
    fn the_conversation_id_prefers_the_ledger_then_the_episode() {
        let mut episode = KnowledgeEpisode {
            id: "e".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "from-episode".into(),
            topic_key: "t".into(),
            counterpart: None,
            teaser: String::new(),
            episode: String::new(),
            facts: Vec::new(),
            source_seq_start: 1,
            source_seq_end: 1,
            source_refs: Vec::new(),
            memory_ids: Vec::new(),
            event_at: None,
            updated_at: String::new(),
        };
        assert_eq!(
            select_conversation_id(std::slice::from_ref(&episode), &[]),
            Some("from-episode".to_string())
        );
        episode.conversation_id = "  ".into();
        assert_eq!(select_conversation_id(&[episode], &[]), None);
    }

    #[test]
    fn a_counterpart_match_is_normalized_and_non_empty() {
        assert!(is_counterpart_match(Some(" Müller "), "muller"));
        assert!(!is_counterpart_match(None, "Max"));
        assert!(!is_counterpart_match(Some("Max"), ""));
    }
}
