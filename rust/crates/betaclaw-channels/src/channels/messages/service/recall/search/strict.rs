//! Port of `src/server/channels/messages/service/recall/search/strict.ts`.
//!
//! Scores chat hits and memory matches against the query, then picks a winner
//! and checks for a conflict with the runner-up.

use std::cmp::Ordering;

use crate::memory::service::{RecallMode, RecallRequest};
use crate::memory::types::{MemoryRecallMatch, MemoryRecallResult};
use crate::messages_store::{Conversation, StoredMessage};

use super::super::constants::{COMMITMENT_TOKENS, RECALL_QUERY_STOP_WORDS, TIME_TOKENS};
use super::super::ports::RecallMemory;
use super::super::types::{CandidateSource, StrictRecallCandidate};
use super::super::utils::{
    apply_recency_boost, count_hits, dedupe_candidates, has_any_token, memory_user_ids,
    normalize_for_match, tokenize_normalized,
};
use crate::channels::messages::service::types::MEMORY_RECALL_LIMIT;

/// The context string of an empty recall (`recallFromMemoryDetailed`).
const NO_MEMORY_CONTEXT: &str = "No relevant memories found.";

/// `StrictSearchResult` (`strict.ts:119-129`).
#[derive(Debug, Clone, PartialEq)]
pub struct StrictSearchResult {
    pub candidates: Vec<StrictRecallCandidate>,
    pub deduped: Vec<StrictRecallCandidate>,
    pub relevant: Vec<StrictRecallCandidate>,
    pub sorted_relevant: Vec<StrictRecallCandidate>,
    pub sorted_context: Vec<StrictRecallCandidate>,
    pub winner: Option<StrictRecallCandidate>,
    pub runner_up: Option<StrictRecallCandidate>,
    pub has_conflict: bool,
    pub topic_tokens: Vec<String>,
}

/// `buildChatCandidates`: source weight by role, plus topic, time and
/// commitment bonuses.
pub fn build_chat_candidates(
    chat_hits: &[StoredMessage],
    topic_tokens: &[String],
    query_time_tokens: &[String],
) -> Vec<StrictRecallCandidate> {
    chat_hits
        .iter()
        .filter_map(|hit| {
            let text = hit.content.trim();
            if text.is_empty() {
                return None;
            }
            let normalized = normalize_for_match(text);
            let topic_hits = count_hits(&normalized, topic_tokens);
            let time_hits = count_hits(&normalized, query_time_tokens);
            let source_weight = match hit.role.as_str() {
                "user" => 2.8,
                "agent" => 1.6,
                _ => 1.2,
            };
            let commitment_bonus = if has_any_token(&normalized, COMMITMENT_TOKENS) {
                0.5
            } else {
                0.0
            };
            Some(StrictRecallCandidate {
                source: CandidateSource::Chat,
                role: hit.role.clone(),
                text: text.to_string(),
                created_at: Some(hit.created_at.clone()),
                normalized,
                topic_hits,
                time_hits,
                score: source_weight
                    + topic_hits as f64 * 4.0
                    + time_hits as f64 * 0.8
                    + commitment_bonus,
            })
        })
        .collect()
}

/// `buildMemoryCandidates`: base weight 2.2 for memory matches.
pub fn build_memory_candidates(
    matches: &[MemoryRecallMatch],
    topic_tokens: &[String],
    query_time_tokens: &[String],
) -> Vec<StrictRecallCandidate> {
    matches
        .iter()
        .filter_map(|found| {
            let text = found.node.content.trim();
            if text.is_empty() {
                return None;
            }
            let normalized = normalize_for_match(text);
            let topic_hits = count_hits(&normalized, topic_tokens);
            let time_hits = count_hits(&normalized, query_time_tokens);
            let commitment_bonus = if has_any_token(&normalized, COMMITMENT_TOKENS) {
                0.4
            } else {
                0.0
            };
            Some(StrictRecallCandidate {
                source: CandidateSource::Memory,
                role: "memory".to_string(),
                text: text.to_string(),
                created_at: Some(found.node.timestamp.clone()),
                normalized,
                topic_hits,
                time_hits,
                score: 2.2 + topic_hits as f64 * 4.0 + time_hits as f64 * 0.6 + commitment_bonus,
            })
        })
        .collect()
}

/// `recallFromMemoryDetailed` (lexical). The first user id with matches wins.
/// Errors are logged and the next id is tried. Without matches the result is
/// the empty sentinel.
pub async fn recall_from_memory_detailed<M: RecallMemory>(
    memory: &M,
    memory_user_ids: &[String],
    conversation: &Conversation,
    persona_id: &str,
    user_input: &str,
) -> MemoryRecallResult {
    for user_id in memory_user_ids {
        let request = RecallRequest {
            mode: RecallMode::Lexical,
            memory_types: None,
            workspace_id: conversation.workspace_id.clone(),
        };
        match memory
            .recall_detailed(
                persona_id,
                user_input,
                MEMORY_RECALL_LIMIT,
                user_id,
                &request,
            )
            .await
        {
            Ok(recalled) if !recalled.matches.is_empty() => return recalled,
            Ok(_) => {}
            Err(error) => tracing::error!(
                error = %crate::safe_error_message(&error),
                "Memory strict recall failed"
            ),
        }
    }
    MemoryRecallResult {
        context: NO_MEMORY_CONTEXT.to_string(),
        matches: Vec::new(),
    }
}

/// `performStrictSearch`.
pub async fn perform_strict_search<M: RecallMemory>(
    memory: &M,
    conversation: &Conversation,
    user_input: &str,
    chat_hits: &[StoredMessage],
    persona_id: &str,
) -> StrictSearchResult {
    let normalized_query = normalize_for_match(user_input);
    let query_tokens = tokenize_normalized(&normalized_query);
    let topic_tokens: Vec<String> = query_tokens
        .iter()
        .filter(|token| !RECALL_QUERY_STOP_WORDS.contains(&token.as_str()))
        .cloned()
        .collect();
    let query_time_tokens: Vec<String> = query_tokens
        .iter()
        .filter(|token| TIME_TOKENS.contains(&token.as_str()))
        .cloned()
        .collect();

    let user_ids = memory_user_ids(conversation);
    let recalled =
        recall_from_memory_detailed(memory, &user_ids, conversation, persona_id, user_input).await;

    let mut candidates = build_chat_candidates(chat_hits, &topic_tokens, &query_time_tokens);
    candidates.extend(build_memory_candidates(
        &recalled.matches,
        &topic_tokens,
        &query_time_tokens,
    ));

    apply_recency_boost(&mut candidates);

    let deduped = dedupe_candidates(candidates.clone());
    let relevant: Vec<StrictRecallCandidate> = if topic_tokens.is_empty() {
        deduped.clone()
    } else {
        deduped
            .iter()
            .filter(|candidate| candidate.topic_hits > 0)
            .cloned()
            .collect()
    };
    let sorted_relevant = sorted_by_score(&relevant);
    let sorted_context = sorted_by_score(
        &deduped
            .iter()
            .filter(|candidate| candidate.time_hits > 0)
            .cloned()
            .collect::<Vec<_>>(),
    );

    let winner = sorted_relevant.first().cloned();
    let runner_up = sorted_relevant.get(1).cloned();
    let has_conflict = match (&winner, &runner_up) {
        (Some(best), Some(second)) => (best.score - second.score).abs() < 0.8,
        _ => false,
    };

    StrictSearchResult {
        candidates,
        deduped,
        relevant,
        sorted_relevant,
        sorted_context,
        winner,
        runner_up,
        has_conflict,
        topic_tokens,
    }
}

/// Stable sort by descending score, as `Array.prototype.sort` does.
fn sorted_by_score(items: &[StrictRecallCandidate]) -> Vec<StrictRecallCandidate> {
    let mut out = items.to_vec();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::recall::ports::RecallSourceError;
    use crate::channels::messages::service::recall::testing::{
        conversation, memory_match, memory_result, no_memory, stored, FakeMemory,
    };

    #[tokio::test]
    async fn topic_and_time_hits_pick_the_winner() {
        let conv = conversation("WebChat", Some("p1"));
        let memory = FakeMemory::answering(Ok(no_memory()));
        let hits = [
            stored(
                "1",
                "agent",
                "Viel Spass beim Training",
                "2026-10-05T10:00:00.000Z",
            ),
            stored(
                "2",
                "user",
                "Ich wollte heute die Ubung Yoga machen",
                "2026-10-05T09:00:00.000Z",
            ),
        ];
        let result = perform_strict_search(
            &memory,
            &conv,
            "Welche Übung wollte ich heute nochmal machen?",
            &hits,
            "p1",
        )
        .await;
        let winner = result.winner.expect("a winner");
        assert_eq!(winner.text, "Ich wollte heute die Ubung Yoga machen");
        assert!(winner.topic_hits > 0);
        assert!(result.topic_tokens.contains(&"ubung".to_string()));
        assert!(!result.topic_tokens.contains(&"heute".to_string()));
    }

    #[tokio::test]
    async fn near_equal_scores_are_a_conflict() {
        let conv = conversation("WebChat", Some("p1"));
        let memory = FakeMemory::answering(Ok(memory_result(
            "ctx",
            vec![memory_match(
                "n1",
                "Yoga Dienstag",
                "2026-10-05T10:00:00.000Z",
            )],
        )));
        let hits = [stored(
            "1",
            "user",
            "Yoga Mittwoch",
            "2026-10-05T10:00:00.000Z",
        )];
        let result = perform_strict_search(&memory, &conv, "Yoga", &hits, "p1").await;
        assert!(result.has_conflict);
        assert_eq!(result.sorted_relevant.len(), 2);
    }

    #[tokio::test]
    async fn memory_error_falls_back_to_the_empty_sentinel() {
        let conv = conversation("WebChat", Some("p1"));
        let memory = FakeMemory::answering(Err(RecallSourceError("boom".to_string())));
        let result =
            recall_from_memory_detailed(&memory, &memory_user_ids(&conv), &conv, "p1", "Yoga")
                .await;
        assert_eq!(result.context, NO_MEMORY_CONTEXT);
        assert!(result.matches.is_empty());
    }
}
