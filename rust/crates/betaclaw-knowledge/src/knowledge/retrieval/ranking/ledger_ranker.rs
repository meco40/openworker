//! Port of `src/server/knowledge/retrieval/ranking/ledgerRanker.ts` (1-40).
//!
//! | TypeScript                                    | Rust |
//! | --------------------------------------------- | ---- |
//! | `ranking/ledgerRanker.ts:7-40` (`rankLedgerByQuery`) | [`rank_ledger_by_query`] |
//!
//! Same shape as [`super::episode_ranker`]: overlap blended with freshness via
//! `adjustRecallScore`, no persona boost, and a date fallback when the two
//! scores are equal. `Date.now()` is injected the same way — see
//! [`super::episode_ranker::compute_episode_age_at`].

use std::cmp::Ordering;

use crate::knowledge::recall_scoring::{adjust_recall_score, RecallScoreInput};
use crate::knowledge::repository::MeetingLedgerEntry;
use crate::knowledge::retrieval::js_date_parse_millis;
use crate::knowledge::retrieval::query::query_parser::tokenize_query_for_ranking;

use super::episode_ranker::compute_episode_age_at;
use super::scoring::compute_token_overlap_score;

fn ledger_text(row: &MeetingLedgerEntry) -> String {
    format!(
        "{} {} {} {} {} {}",
        row.topic_key,
        row.counterpart.clone().unwrap_or_default(),
        row.decisions.join(" "),
        row.negotiated_terms.join(" "),
        row.open_points.join(" "),
        row.action_items.join(" ")
    )
}

fn ledger_score(row: &MeetingLedgerEntry, tokens: &[String], now_ms: f64) -> f64 {
    let overlap = compute_token_overlap_score(&ledger_text(row), tokens);
    adjust_recall_score(&RecallScoreInput {
        base_score: if overlap == 0.0 { 0.1 } else { overlap },
        confidence: 0.5,
        age_days: compute_episode_age_at(Some(row.updated_at.as_str()), now_ms),
        temporal_status: None,
        is_supersceded: None,
    })
}

/// `rankLedgerByQuery` from `ranking/ledgerRanker.ts:7-40` at a fixed instant.
pub fn rank_ledger_by_query_at(
    ledger_rows: &[MeetingLedgerEntry],
    query: &str,
    now_ms: f64,
) -> Vec<MeetingLedgerEntry> {
    let tokens = tokenize_query_for_ranking(query);
    if tokens.is_empty() {
        return ledger_rows.to_vec();
    }

    let mut ordered = ledger_rows.to_vec();
    ordered.sort_by(|left, right| {
        let left_score = ledger_score(left, &tokens, now_ms);
        let right_score = ledger_score(right, &tokens, now_ms);
        if right_score != left_score {
            return (right_score - left_score)
                .partial_cmp(&0.0)
                .unwrap_or(Ordering::Equal);
        }
        let right_date = js_date_parse_millis(&right.updated_at);
        let left_date = js_date_parse_millis(&left.updated_at);
        (right_date - left_date)
            .partial_cmp(&0.0)
            .unwrap_or(Ordering::Equal)
    });
    ordered
}

/// `rankLedgerByQuery` from `ranking/ledgerRanker.ts:7-40`.
pub fn rank_ledger_by_query(
    ledger_rows: &[MeetingLedgerEntry],
    query: &str,
) -> Vec<MeetingLedgerEntry> {
    rank_ledger_by_query_at(ledger_rows, query, super::episode_ranker::now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, topic: &str, decisions: Vec<&str>, updated_at: &str) -> MeetingLedgerEntry {
        MeetingLedgerEntry {
            id: id.to_string(),
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            conversation_id: "c".to_string(),
            topic_key: topic.to_string(),
            counterpart: None,
            event_at: None,
            participants: Vec::new(),
            decisions: decisions.into_iter().map(str::to_string).collect(),
            negotiated_terms: Vec::new(),
            open_points: Vec::new(),
            action_items: Vec::new(),
            source_refs: Vec::new(),
            confidence: 0.5,
            memory_ids: Vec::new(),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn an_empty_query_keeps_the_input_order() {
        let rows = vec![row("a", "x", vec![], ""), row("b", "y", vec![], "")];
        assert_eq!(rank_ledger_by_query(&rows, "was wie wann"), rows);
    }

    #[test]
    fn the_stronger_overlap_ranks_first() {
        let rows = vec![
            row("a", "sauna", vec!["warm"], "2024-06-15T10:30:00.000Z"),
            row(
                "b",
                "vertrag",
                vec!["rabatt gewaehrt"],
                "2024-06-15T10:30:00.000Z",
            ),
        ];
        let ranked = rank_ledger_by_query_at(&rows, "rabatt vertrag", 1_718_447_400_000.0);
        assert_eq!(ranked[0].id, "b");
    }
}
