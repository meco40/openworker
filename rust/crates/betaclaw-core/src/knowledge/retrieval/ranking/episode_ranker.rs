//! Port of `src/server/knowledge/retrieval/ranking/episodeRanker.ts` (1-53).
//!
//! | TypeScript                                        | Rust |
//! | ------------------------------------------------- | ---- |
//! | `ranking/episodeRanker.ts:8-12` (`computeEpisodeAge`) | [`compute_episode_age`] |
//! | `ranking/episodeRanker.ts:14-53` (`rankEpisodesByQuery`) | [`rank_episodes_by_query`] |
//!
//! # Deviations
//!
//! 1. **`Date.now()` is injected.** `computeEpisodeAge` reads the wall clock;
//!    the public [`compute_episode_age`] does too (via [`SystemTime`]), and
//!    [`compute_episode_age_at`] / [`rank_episodes_by_query_at`] take the instant
//!    so the order is deterministic in tests — the same split the query planner
//!    uses (`plan_knowledge_query_at`).
//! 2. **A `NaN` comparator sorts as equal.** `Array#sort` treats a `NaN` result
//!    as `+0`; the port maps every `NaN`/`partial_cmp` failure to
//!    [`Ordering::Equal`], which is the same "no reorder".
//! 3. `Date.parse` is [`crate::knowledge::retrieval::js_date_parse_millis`]: it
//!    accepts the RFC 3339 and date-only forms the stores write and returns `NaN`
//!    otherwise (see that function's note on offset-less date-times).

use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::knowledge::persona_strategies::{adjust_score_by_strategy, NodeMetadata};
use crate::knowledge::recall_scoring::{adjust_recall_score, RecallScoreInput};
use crate::knowledge::repository::KnowledgeEpisode;
use crate::knowledge::retrieval::js_date_parse_millis;
use crate::knowledge::retrieval::query::query_parser::tokenize_query_for_ranking;
use crate::personas::types::MemoryPersonaType;

use super::scoring::{compute_token_overlap_score, detect_emotional_tone_in_text};

/// `Date.now()` in milliseconds.
pub(crate) fn now_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

/// `computeEpisodeAge` from `ranking/episodeRanker.ts:8-12` at a fixed instant.
pub fn compute_episode_age_at(updated_at: Option<&str>, now_ms: f64) -> f64 {
    let parsed = js_date_parse_millis(updated_at.unwrap_or(""));
    if !parsed.is_finite() {
        return 365.0;
    }
    ((now_ms - parsed) / 86_400_000.0).max(0.0)
}

/// `computeEpisodeAge` from `ranking/episodeRanker.ts:8-12`.
pub fn compute_episode_age(updated_at: Option<&str>) -> f64 {
    compute_episode_age_at(updated_at, now_millis())
}

fn episode_text(episode: &KnowledgeEpisode) -> String {
    format!(
        "{} {} {} {}",
        episode.topic_key,
        episode.teaser,
        episode.episode,
        episode.facts.join(" ")
    )
}

fn episode_facts(episode: &KnowledgeEpisode) -> String {
    episode.facts.join(" ")
}

/// One `adjustRecallScore({ baseScore: overlap || 0.1, confidence: 0.5, ageDays })`
/// followed by the persona strategy boost (`:31-48`).
fn episode_score(
    episode: &KnowledgeEpisode,
    tokens: &[String],
    persona_type: MemoryPersonaType,
    now_ms: f64,
) -> f64 {
    let overlap = compute_token_overlap_score(&episode_text(episode), tokens);
    let base = adjust_recall_score(&RecallScoreInput {
        base_score: if overlap == 0.0 { 0.1 } else { overlap },
        confidence: 0.5,
        age_days: compute_episode_age_at(Some(episode.updated_at.as_str()), now_ms),
        temporal_status: None,
        is_supersceded: None,
    });
    adjust_score_by_strategy(
        base,
        persona_type,
        &NodeMetadata {
            emotional_tone: detect_emotional_tone_in_text(&episode_facts(episode)),
            node_type: Some(episode.topic_key.clone()),
        },
    )
}

/// `rankEpisodesByQuery` from `ranking/episodeRanker.ts:14-53` at a fixed
/// instant.
pub fn rank_episodes_by_query_at(
    episodes: &[KnowledgeEpisode],
    query: &str,
    persona_type: MemoryPersonaType,
    now_ms: f64,
) -> Vec<KnowledgeEpisode> {
    let tokens = tokenize_query_for_ranking(query);
    if tokens.is_empty() {
        return episodes.to_vec();
    }

    let mut ordered = episodes.to_vec();
    ordered.sort_by(|left, right| {
        let left_score = episode_score(left, &tokens, persona_type, now_ms);
        let right_score = episode_score(right, &tokens, persona_type, now_ms);
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

/// `rankEpisodesByQuery` from `ranking/episodeRanker.ts:14-53`.
pub fn rank_episodes_by_query(
    episodes: &[KnowledgeEpisode],
    query: &str,
    persona_type: MemoryPersonaType,
) -> Vec<KnowledgeEpisode> {
    rank_episodes_by_query_at(episodes, query, persona_type, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(id: &str, topic: &str, facts: Vec<&str>, updated_at: &str) -> KnowledgeEpisode {
        KnowledgeEpisode {
            id: id.to_string(),
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            conversation_id: "c".to_string(),
            topic_key: topic.to_string(),
            counterpart: None,
            teaser: String::new(),
            episode: String::new(),
            facts: facts.into_iter().map(str::to_string).collect(),
            source_seq_start: 1,
            source_seq_end: 1,
            source_refs: Vec::new(),
            memory_ids: Vec::new(),
            event_at: None,
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn the_age_falls_back_to_365_for_unparseable_dates() {
        let now = 1_718_447_400_000.0;
        assert_eq!(compute_episode_age_at(None, now), 365.0);
        assert_eq!(compute_episode_age_at(Some("kein Datum"), now), 365.0);
        assert_eq!(
            compute_episode_age_at(Some("2024-06-14T10:30:00.000Z"), now),
            1.0
        );
        assert_eq!(
            compute_episode_age_at(Some("2024-06-16T10:30:00.000Z"), now),
            0.0
        );
    }

    #[test]
    fn an_empty_query_keeps_the_input_order() {
        let episodes = vec![episode("a", "x", vec![], ""), episode("b", "y", vec![], "")];
        let ranked = rank_episodes_by_query(&episodes, "was wie wann", MemoryPersonaType::General);
        assert_eq!(ranked, episodes);
    }

    #[test]
    fn the_stronger_overlap_ranks_first() {
        let episodes = vec![
            episode("a", "sauna", vec!["warm"], "2024-06-15T10:30:00.000Z"),
            episode("b", "vertrag", vec!["rabatt"], "2024-06-15T10:30:00.000Z"),
        ];
        let ranked = rank_episodes_by_query_at(
            &episodes,
            "was war mit dem vertrag",
            MemoryPersonaType::General,
            1_718_447_400_000.0,
        );
        assert_eq!(ranked[0].id, "b");
    }
}
