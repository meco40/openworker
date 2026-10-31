//! Port of `src/server/knowledge/retrieval/service/queryPlanning.ts` (1-95).
//!
//! | TypeScript                                                    | Rust |
//! | ------------------------------------------------------------- | ---- |
//! | `service/queryPlanning.ts:14-18` (`isRulesIntent`)             | [`is_rules_intent`] |
//! | `service/queryPlanning.ts:20-49` (`shouldTriggerRecallForQuery`)| [`should_trigger_recall_for_query`] |
//! | `service/queryPlanning.ts:51-76` (`resolveEntityContext`)      | [`resolve_entity_context`] |
//! | `service/queryPlanning.ts:78-95` (`computeCountRecallAnswer`)  | [`compute_count_recall_answer`] |
//!
//! # Pattern transcription
//!
//! `/i` becomes `(?i)`, every `\b` becomes `(?-u:\b)` and `\s` is left alone
//! (JavaScript's ASCII `\b`; see `query/intent_detector.rs`).
//!
//! # Deviations
//!
//! 1. **The three optional repository members are `None`-returning.** The
//!    TypeScript presence guards (`!repo.resolveEntity`, …) have no Rust
//!    counterpart; a `None` here means "absent or returned nothing", which the
//!    two callers already treat the same way (`types.rs` deviation 2).
//! 2. **`computeEventAnswer`'s minimal repo is an adapter.** The bound method
//!    `countUniqueDays` becomes [`CountRecallRepo`], which forwards to
//!    [`RetrievalKnowledgeRepository::count_unique_days`] and yields the empty
//!    aggregation when the member is absent.
//! 3. `plan.topic` / `plan.eventFilter` / `plan.counterpartAliases` are `Option`.

use std::sync::OnceLock;

use regex::Regex;

use crate::knowledge::entity_graph::{EntityCategory, EntityGraphFilter};
use crate::knowledge::event_answer_computer::{
    compute_event_answer, EventAnswerFilter, EventAnswerScope, EventCountRepository,
};
use crate::knowledge::event_types::{EventAggregationResult, KnowledgeEventFilter};
use crate::knowledge::query_planner::{KnowledgeQueryIntent, KnowledgeQueryPlan};
use crate::knowledge::retrieval::formatters::context_formatter::format_project_graph;
use crate::knowledge::retrieval::pattern;
use crate::knowledge::retrieval::query::intent_detector::{
    detect_mentioned_counterpart, normalize_lookup_text,
};
use crate::knowledge::retrieval::types::{
    KnowledgeRecallProbeInput, RetrievalKnowledgeRepository, RetrievalResult,
};

static RULES_INTENT: OnceLock<Regex> = OnceLock::new();
static QUESTION_HEAD: OnceLock<Regex> = OnceLock::new();
static DIRECTIVE: OnceLock<Regex> = OnceLock::new();
static RETROSPECTIVE: OnceLock<Regex> = OnceLock::new();
static RECALL_VERB: OnceLock<Regex> = OnceLock::new();

/// `isRulesIntent` from `service/queryPlanning.ts:14-18`.
///
/// Unlike `query/intentDetector.ts:isRulesIntentQuery` this reads the *raw*
/// query, exactly like the source.
pub fn is_rules_intent(query: &str) -> bool {
    pattern(
        r"(?i)(?-u:\b)(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)(?-u:\b)",
        &RULES_INTENT,
    )
    .is_match(query)
}

/// `shouldTriggerRecallForQuery` from `service/queryPlanning.ts:20-49`.
pub fn should_trigger_recall_for_query(
    input: &KnowledgeRecallProbeInput,
    known_counterparts: &[String],
) -> bool {
    let normalized_query = normalize_lookup_text(&input.query);
    if normalized_query.is_empty() {
        return false;
    }

    let has_question_signal = input.query.contains('?')
        || pattern(
            r"(?i)^(was|wie|wann|wo|wer|warum|wieso|which|what|when|where|who)(?-u:\b)",
            &QUESTION_HEAD,
        )
        .is_match(&normalized_query);
    let directive_recall_intent = pattern(
        r"(?i)(?-u:\b)(nenne|sag|sage|liste|list|zeige|zeig|erzaehl|erzahl|remember|recall|tell|summarize)(?-u:\b)",
        &DIRECTIVE,
    )
    .is_match(&normalized_query);
    if is_rules_intent(&normalized_query) && (has_question_signal || directive_recall_intent) {
        return true;
    }
    if !has_question_signal && !directive_recall_intent {
        return false;
    }

    let retrospective_hint = pattern(
        r"(?i)(?-u:\b)(gestern|vorgestern|letzte[nrsm]?|vor\s+\d+\s+(tag|tagen|woche|wochen|monat|monaten|jahr|jahren)|damals|zuvor|fruher|frueher|letztens|neulich)(?-u:\b)",
        &RETROSPECTIVE,
    )
    .is_match(&normalized_query);
    let recall_verb = pattern(
        r"(?i)(?-u:\b)(gesagt|besprochen|diskutiert|vereinbart|ausgehandelt|gemeint|gelaufen|war|passiert|geklart|geklaert)(?-u:\b)",
        &RECALL_VERB,
    )
    .is_match(&normalized_query);
    if retrospective_hint && recall_verb {
        return true;
    }

    detect_mentioned_counterpart(&input.query, known_counterparts).is_some()
}

/// `resolveEntityContext` from `service/queryPlanning.ts:51-76`.
pub fn resolve_entity_context(
    plan: &KnowledgeQueryPlan,
    user_id: &str,
    persona_id: &str,
    knowledge_repository: &dyn RetrievalKnowledgeRepository,
) -> RetrievalResult<String> {
    if plan.intent != KnowledgeQueryIntent::GeneralRecall {
        return Ok(String::new());
    }
    let Some(topic) = plan.topic.as_deref() else {
        return Ok(String::new());
    };

    let graph_filter = EntityGraphFilter {
        user_id: user_id.to_string(),
        persona_id: persona_id.to_string(),
        ..EntityGraphFilter::default()
    };
    let Some(topic_match) = knowledge_repository.resolve_entity(topic, &graph_filter)? else {
        return Ok(String::new());
    };
    if topic_match.entity.category != EntityCategory::Project {
        return Ok(String::new());
    }

    let Some(with_relations) =
        knowledge_repository.get_entity_with_relations(&topic_match.entity.id)?
    else {
        return Ok(String::new());
    };
    let Some(related_entities) =
        knowledge_repository.get_related_entities(&topic_match.entity.id)?
    else {
        return Ok(String::new());
    };
    Ok(format_project_graph(
        &topic_match.entity.canonical_name,
        &with_relations.relations,
        &related_entities,
    ))
}

/// The minimal `EventCountRepository` of `computeCountRecallAnswer` (`:88-94`).
struct CountRecallRepo<'a> {
    knowledge_repository: &'a dyn RetrievalKnowledgeRepository,
}

impl EventCountRepository for CountRecallRepo<'_> {
    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> RetrievalResult<EventAggregationResult> {
        Ok(self
            .knowledge_repository
            .count_unique_days(filter)?
            .unwrap_or(EventAggregationResult {
                unique_day_count: 0,
                unique_days: Vec::new(),
                event_count: 0,
                events: Vec::new(),
            }))
    }
}

/// `computeCountRecallAnswer` from `service/queryPlanning.ts:78-95`.
pub fn compute_count_recall_answer(
    plan: &KnowledgeQueryPlan,
    user_id: &str,
    persona_id: &str,
    knowledge_repository: &dyn RetrievalKnowledgeRepository,
) -> RetrievalResult<Option<String>> {
    if plan.intent != KnowledgeQueryIntent::CountRecall {
        return Ok(None);
    }
    let Some(filter) = plan.event_filter.as_ref() else {
        return Ok(None);
    };
    compute_event_answer(
        &EventAnswerFilter {
            event_type: filter.event_type.clone(),
            counterpart_entity: filter.counterpart_entity.clone(),
            from: None,
            to: None,
        },
        &EventAnswerScope {
            user_id: user_id.to_string(),
            persona_id: persona_id.to_string(),
        },
        &CountRecallRepo {
            knowledge_repository,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::query_planner::{
        KnowledgeDetailDepth, KnowledgeEventQueryFilter, KnowledgeQueryPlan,
    };
    use crate::knowledge::repository::{
        InsertRetrievalAuditInput, KnowledgeEpisode, ListKnowledgeFilter, MeetingLedgerEntry,
        RetrievalAuditEntry,
    };
    use crate::knowledge::retrieval::types::{RetrievalError, RetrievalResult};

    struct FakeRepo {
        count: Option<EventAggregationResult>,
    }

    impl RetrievalKnowledgeRepository for FakeRepo {
        fn list_meeting_ledger(
            &self,
            _filter: &ListKnowledgeFilter,
        ) -> RetrievalResult<Vec<MeetingLedgerEntry>> {
            Ok(Vec::new())
        }
        fn list_episodes(
            &self,
            _filter: &ListKnowledgeFilter,
        ) -> RetrievalResult<Vec<KnowledgeEpisode>> {
            Ok(Vec::new())
        }
        fn insert_retrieval_audit(
            &self,
            _input: &InsertRetrievalAuditInput,
        ) -> RetrievalResult<RetrievalAuditEntry> {
            Err(RetrievalError::new("unused in this test"))
        }
        fn count_unique_days(
            &self,
            _filter: &KnowledgeEventFilter,
        ) -> RetrievalResult<Option<EventAggregationResult>> {
            Ok(self.count.clone())
        }
    }

    fn probe(query: &str) -> KnowledgeRecallProbeInput {
        KnowledgeRecallProbeInput {
            user_id: "u".into(),
            persona_id: "p".into(),
            query: query.into(),
        }
    }

    #[test]
    fn a_rules_question_or_directive_triggers_recall() {
        assert!(should_trigger_recall_for_query(
            &probe("was sind die Regeln?"),
            &[]
        ));
        assert!(should_trigger_recall_for_query(
            &probe("nenne die regeln"),
            &[]
        ));
        assert!(!should_trigger_recall_for_query(
            &probe("die Sauna war warm"),
            &[]
        ));
        assert!(!should_trigger_recall_for_query(&probe(""), &[]));
    }

    #[test]
    fn a_retrospective_question_with_a_recall_verb_triggers_recall() {
        assert!(should_trigger_recall_for_query(
            &probe("was haben wir gestern besprochen?"),
            &[]
        ));
    }

    #[test]
    fn a_count_query_is_answered_from_the_events() {
        let repo = FakeRepo {
            count: Some(EventAggregationResult {
                unique_day_count: 2,
                unique_days: vec!["2024-01-01".into(), "2024-01-02".into()],
                event_count: 2,
                events: Vec::new(),
            }),
        };
        let plan = KnowledgeQueryPlan {
            intent: KnowledgeQueryIntent::CountRecall,
            time_range: None,
            counterpart: None,
            topic: None,
            detail_depth: KnowledgeDetailDepth::Low,
            event_filter: Some(KnowledgeEventQueryFilter {
                event_type: Some("meal".into()),
                counterpart_entity: None,
            }),
            resolved_entity_id: None,
            resolved_entity_name: None,
            counterpart_aliases: None,
        };
        let answer = compute_count_recall_answer(&plan, "u", "p", &repo)
            .expect("count query")
            .expect("answer");
        assert!(answer.contains("2 Tage"));
        assert!(answer.contains("gegessen"));
        assert!(answer.contains("2024-01-01"));
    }

    #[test]
    fn a_non_project_topic_yields_no_entity_context() {
        let plan = KnowledgeQueryPlan {
            intent: KnowledgeQueryIntent::GeneralRecall,
            time_range: None,
            counterpart: None,
            topic: Some("urlaub".into()),
            detail_depth: KnowledgeDetailDepth::Low,
            event_filter: None,
            resolved_entity_id: None,
            resolved_entity_name: None,
            counterpart_aliases: None,
        };
        let repo = FakeRepo { count: None };
        assert_eq!(
            resolve_entity_context(&plan, "u", "p", &repo).expect("lookup"),
            ""
        );
    }
}
