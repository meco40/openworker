//! Port of `src/server/knowledge/retrieval/formatters/answerDraftBuilder.ts` (1-105).
//!
//! | TypeScript                                                    | Rust |
//! | ------------------------------------------------------------- | ---- |
//! | `formatters/answerDraftBuilder.ts:6-17` (`AnswerDraftInput`)   | [`AnswerDraftInput`] |
//! | `formatters/answerDraftBuilder.ts:19-63` (`buildAnswerDraft`)  | [`build_answer_draft`] |
//! | `formatters/answerDraftBuilder.ts:65-77` (`filterListsForRulesIntent`) | [`filter_lists_for_rules_intent`] |
//! | `formatters/answerDraftBuilder.ts:79-105` (`extractCounterpartAndLists`) | [`extract_counterpart_and_lists`] |
//!
//! # Deviations
//!
//! 1. **`AnswerDraftInput` borrows.** The TypeScript object literal is built and
//!    consumed once by `retrievalExecution.ts:249-260`; the port takes slices so
//!    the caller does not clone the ledger rows and episodes.
//! 2. **`fallbackRuleHighlights || []` is a slice.** Absent and empty are the
//!    same list, so the port takes `&[String]` and the caller passes `&[]`.
//! 3. **The `||` chains become "first non-empty".** `episode.teaser || ''`,
//!    `row.counterpart || latestEpisode?.counterpart || planCounterpart` and the
//!    `computedAnswerText ? … : …` guards all treat the empty string as absent;
//!    the port uses `Option`/`is_empty` accordingly.
//! 4. `extractRuleFragments(text)` uses the default `maxFragments = 6`
//!    (`rulesExtractor.ts:28`); the port passes `6` explicitly.

use crate::knowledge::repository::{KnowledgeEpisode, MeetingLedgerEntry};
use crate::knowledge::retrieval::formatters::display_utils::to_display_name;
use crate::knowledge::retrieval::query::rules_extractor::{
    extract_rule_fragments, is_rule_like_statement,
};
use crate::knowledge::retrieval::utils::unique_strings;

/// `AnswerDraftInput` from `formatters/answerDraftBuilder.ts:6-17`.
pub struct AnswerDraftInput<'a> {
    pub rules_intent: bool,
    pub ledger_rows: &'a [MeetingLedgerEntry],
    pub episodes: &'a [KnowledgeEpisode],
    pub fallback_rule_highlights: &'a [String],
    pub counterpart: Option<&'a str>,
    pub computed_answer_text: Option<&'a str>,
    pub entity_context_section: &'a str,
    pub semantic_context: &'a str,
    pub key_decisions_list: &'a [String],
    pub open_points_list: &'a [String],
}

/// `buildAnswerDraft` from `formatters/answerDraftBuilder.ts:19-63`.
pub fn build_answer_draft(input: &AnswerDraftInput<'_>) -> Vec<String> {
    if input.rules_intent {
        let mut candidates: Vec<String> = Vec::new();
        candidates.extend(input.key_decisions_list.iter().cloned());
        candidates.extend(input.open_points_list.iter().cloned());
        candidates.extend(input.fallback_rule_highlights.iter().cloned());
        for episode in input.episodes {
            let text = format!(
                "{}\n{}\n{}",
                episode.teaser,
                episode.episode,
                episode.facts.join("\n")
            );
            candidates.extend(extract_rule_fragments(&text, 6));
        }
        for row in input.ledger_rows {
            let text = format!(
                "{}\n{}\n{}\n{}",
                row.decisions.join("\n"),
                row.negotiated_terms.join("\n"),
                row.open_points.join("\n"),
                row.action_items.join("\n")
            );
            candidates.extend(extract_rule_fragments(&text, 6));
        }
        let rule_highlights: Vec<String> = unique_strings(candidates).into_iter().take(8).collect();
        let mut lines = vec!["Kontext: Regelwissen aus Historie.".to_string()];
        lines.extend(
            rule_highlights
                .into_iter()
                .map(|entry| format!("- {}", entry)),
        );
        return lines;
    }

    let mut lines: Vec<String> = Vec::new();
    if let Some(answer) = input.computed_answer_text {
        lines.push(answer.to_string());
    }
    if !input.entity_context_section.is_empty() {
        lines.push(format!(
            "[Entity-Kontext]\n{}",
            input.entity_context_section
        ));
    }
    lines.push(match input.counterpart {
        Some(counterpart) => format!("Kontext: Meeting mit {}.", counterpart),
        None => "Kontext: Wissensrueckgriff aktiv.".to_string(),
    });
    lines.push(
        input
            .episodes
            .first()
            .map(|e| e.teaser.clone())
            .unwrap_or_default(),
    );
    lines.push(input.semantic_context.to_string());
    lines
}

/// The `{ keyDecisions, openPoints }` of `filterListsForRulesIntent` (`:65-77`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilteredLists {
    pub key_decisions: Vec<String>,
    pub open_points: Vec<String>,
}

/// `filterListsForRulesIntent` from `formatters/answerDraftBuilder.ts:65-77`.
pub fn filter_lists_for_rules_intent(
    rules_intent: bool,
    key_decisions_list: &[String],
    open_points_list: &[String],
) -> FilteredLists {
    if !rules_intent {
        return FilteredLists {
            key_decisions: key_decisions_list.to_vec(),
            open_points: open_points_list.to_vec(),
        };
    }
    FilteredLists {
        key_decisions: key_decisions_list
            .iter()
            .filter(|entry| is_rule_like_statement(entry))
            .cloned()
            .collect(),
        open_points: open_points_list
            .iter()
            .filter(|entry| is_rule_like_statement(entry))
            .cloned()
            .collect(),
    }
}

/// The `{ counterpart, keyDecisionsList, openPointsList }` of
/// `extractCounterpartAndLists` (`:79-105`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterpartAndLists {
    pub counterpart: Option<String>,
    pub key_decisions_list: Vec<String>,
    pub open_points_list: Vec<String>,
}

/// `extractCounterpartAndLists` from `formatters/answerDraftBuilder.ts:79-105`.
pub fn extract_counterpart_and_lists(
    ledger_rows: &[MeetingLedgerEntry],
    episodes: &[KnowledgeEpisode],
    plan_counterpart: Option<&str>,
) -> CounterpartAndLists {
    let mut key_candidates: Vec<String> = Vec::new();
    for row in ledger_rows {
        key_candidates.extend(row.decisions.iter().cloned());
        key_candidates.extend(row.negotiated_terms.iter().cloned());
    }
    if let Some(episode) = episodes.first() {
        key_candidates.extend(episode.facts.iter().cloned());
    }
    let key_decisions_list = unique_strings(key_candidates);

    let mut open_candidates: Vec<String> = Vec::new();
    for row in ledger_rows {
        open_candidates.extend(row.open_points.iter().cloned());
        open_candidates.extend(row.action_items.iter().cloned());
    }
    let open_points_list = unique_strings(open_candidates);

    let counterpart_source = ledger_rows
        .first()
        .and_then(|row| row.counterpart.as_deref())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            episodes
                .first()
                .and_then(|episode| episode.counterpart.as_deref())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| plan_counterpart.filter(|value| !value.is_empty()));

    CounterpartAndLists {
        counterpart: to_display_name(counterpart_source),
        key_decisions_list,
        open_points_list,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(teaser: &str, facts: Vec<&str>) -> KnowledgeEpisode {
        KnowledgeEpisode {
            id: "e".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            topic_key: "t".into(),
            counterpart: Some("max".into()),
            teaser: teaser.into(),
            episode: String::new(),
            facts: facts.into_iter().map(str::to_string).collect(),
            source_seq_start: 1,
            source_seq_end: 1,
            source_refs: Vec::new(),
            memory_ids: Vec::new(),
            event_at: None,
            updated_at: String::new(),
        }
    }

    fn ledger(decisions: Vec<&str>, open_points: Vec<&str>) -> MeetingLedgerEntry {
        MeetingLedgerEntry {
            id: "l".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            topic_key: "t".into(),
            counterpart: Some("max".into()),
            event_at: None,
            participants: Vec::new(),
            decisions: decisions.into_iter().map(str::to_string).collect(),
            negotiated_terms: Vec::new(),
            open_points: open_points.into_iter().map(str::to_string).collect(),
            action_items: Vec::new(),
            source_refs: Vec::new(),
            confidence: 0.5,
            memory_ids: Vec::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_plain_draft_lists_answer_context_teaser_and_semantics() {
        let episodes = vec![episode("Kurzer Teaser", vec![])];
        let input = AnswerDraftInput {
            rules_intent: false,
            ledger_rows: &[],
            episodes: &episodes,
            fallback_rule_highlights: &[],
            counterpart: Some("Max"),
            computed_answer_text: Some("Antwort"),
            entity_context_section: "",
            semantic_context: "sem",
            key_decisions_list: &[],
            open_points_list: &[],
        };
        assert_eq!(
            build_answer_draft(&input),
            vec![
                "Antwort".to_string(),
                "Kontext: Meeting mit Max.".to_string(),
                "Kurzer Teaser".to_string(),
                "sem".to_string(),
            ]
        );
    }

    #[test]
    fn a_rules_draft_collects_rule_highlights() {
        let ledger_rows = vec![ledger(vec!["1. Immer pruefen"], vec![])];
        let input = AnswerDraftInput {
            rules_intent: true,
            ledger_rows: &ledger_rows,
            episodes: &[],
            fallback_rule_highlights: &[],
            counterpart: None,
            computed_answer_text: None,
            entity_context_section: "",
            semantic_context: "",
            key_decisions_list: &[],
            open_points_list: &[],
        };
        let draft = build_answer_draft(&input);
        assert_eq!(draft[0], "Kontext: Regelwissen aus Historie.");
        assert!(draft.iter().any(|line| line == "- 1. Immer pruefen"));
    }

    #[test]
    fn the_rule_filter_keeps_only_rule_like_entries() {
        let keys = vec!["1. gilt".to_string(), "Sauna".to_string()];
        let open = vec!["2. offen".to_string()];
        let filtered = filter_lists_for_rules_intent(true, &keys, &open);
        assert_eq!(filtered.key_decisions, vec!["1. gilt".to_string()]);
        assert_eq!(filtered.open_points, vec!["2. offen".to_string()]);
        let unfiltered = filter_lists_for_rules_intent(false, &keys, &open);
        assert_eq!(unfiltered.key_decisions, keys);
    }

    #[test]
    fn the_counterpart_is_display_cased_from_the_first_source() {
        let ledger_rows = vec![ledger(vec![], vec![])];
        let extracted = extract_counterpart_and_lists(&ledger_rows, &[], Some("fallback"));
        assert_eq!(extracted.counterpart, Some("Max".to_string()));
        let fallback = extract_counterpart_and_lists(&[], &[], Some("frida"));
        assert_eq!(fallback.counterpart, Some("Frida".to_string()));
    }
}
