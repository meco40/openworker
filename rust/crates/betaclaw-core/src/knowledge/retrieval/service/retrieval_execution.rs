//! Port of `src/server/knowledge/retrieval/service/retrievalExecution.ts` (1-341).
//!
//! | TypeScript                                                     | Rust |
//! | -------------------------------------------------------------- | ---- |
//! | `service/retrievalExecution.ts:29-33` (`ExecuteKnowledgeRetrievalArgs`) | [`ExecuteKnowledgeRetrievalArgs`] |
//! | `service/retrievalExecution.ts:35-341` (`executeKnowledgeRetrieval`) | [`execute_knowledge_retrieval`] |
//!
//! # Deviations
//!
//! Entity resolution, count answers and project-graph lookup happen before the
//! retrieval catch, matching the TypeScript function; those errors propagate
//! without a retrieval audit.
//!
//! 1. **Synchronous.** The source is `async` because `memoryService.recallDetailed`
//!    returns a promise; the crate's memory seam is synchronous, so the port is a
//!    plain function (see `retrieval/types.rs` deviation 1).
//! 2. **`Date.now()` is injected.** [`execute_knowledge_retrieval_at`] takes the
//!    instant for the rankers; the public [`execute_knowledge_retrieval`] reads
//!    the clock.
//! 3. **The `try`/`catch` is a closure.** The `catch` reads `error.message`
//!    ([`crate::knowledge::retrieval::types::RetrievalError`]) and writes the same
//!    audit row; a repository error is [`RetrievalResult`].
//! 4. **`insertRetrievalAudit`'s return value is dropped.** The source does not
//!    await it; the port ignores the [`crate::knowledge::retrieval::types::RetrievalResult`],
//!    so an audit failure cannot turn into a second audit call in the `catch`.
//! 5. **`tokenCount` is an integer.** [`crate::knowledge::retrieval::types::KnowledgeRetrievalResult::token_count`]
//!    is `i64`, so the `f64` of `estimateTokenCount` is cast once at the boundary.

use std::collections::BTreeMap;

use super::types::RuleEvidenceEntry;
use crate::knowledge::entity_graph::EntityGraphFilter;
use crate::knowledge::event_types::KnowledgeEventFilter;
use crate::knowledge::query_planner::plan_knowledge_query;
use crate::knowledge::repository::{
    InsertRetrievalAuditInput, KnowledgeEpisode, MeetingLedgerEntry,
};
use crate::knowledge::retrieval::formatters::answer_draft_builder::AnswerDraftInput;
use crate::knowledge::retrieval::formatters::budget_calculator::BudgetContext;
use crate::knowledge::retrieval::formatters::evidence_builder::{
    build_evidence, EvidenceOptions, EvidenceSourceRef,
};
use crate::knowledge::retrieval::query::intent_detector::detect_mentioned_counterpart;
use crate::knowledge::retrieval::ranking::episode_ranker::{now_millis, rank_episodes_by_query_at};
use crate::knowledge::retrieval::ranking::ledger_ranker::rank_ledger_by_query_at;
use crate::knowledge::retrieval::types::{
    KnowledgeRetrievalInput, KnowledgeRetrievalResult, KnowledgeRetrievalSections,
    KnowledgeRetrievalServiceOptions, MemoryRecallOptions, MemoryRecallResult, RetrievalResult,
};
use crate::knowledge::retrieval::utils::unique_strings;
use crate::personas::types::MemoryPersonaType;

use super::formatters::{
    build_answer_draft, build_semantic_context_for_query, calculate_and_apply_budget,
    extract_counterpart_and_lists, filter_lists_for_rules_intent, is_counterpart_match,
    select_conversation_id,
};
use super::query::intent::detect_binary_recall_conflict;
use super::query::rules::{has_rule_like_fragments, has_valid_source_refs};
use super::query_planning::{compute_count_recall_answer, is_rules_intent, resolve_entity_context};
use super::rule_evidence_collector::collect_rule_fallback_evidence;

/// `ExecuteKnowledgeRetrievalArgs` from `service/retrievalExecution.ts:29-33`.
pub struct ExecuteKnowledgeRetrievalArgs<'a> {
    pub input: &'a KnowledgeRetrievalInput,
    pub options: &'a KnowledgeRetrievalServiceOptions<'a>,
    pub max_context_tokens: f64,
}

/// The four "Unklar" sections of `service/retrievalExecution.ts:271-278`.
fn uncertain_rule_sections() -> KnowledgeRetrievalSections {
    KnowledgeRetrievalSections {
        answer_draft: "Unklar: In der Knowledge sind aktuell keine belegten Regeln mit Evidenz-Referenzen vorhanden.".to_string(),
        key_decisions: "Unklar: Keine belegten Regel-Fakten gefunden.".to_string(),
        open_points: "Unklar: Keine belegten offenen Regel-Punkte gefunden.".to_string(),
        evidence: "Keine belegten Evidenz-Referenzen fuer Regeln gefunden.".to_string(),
    }
}

/// `executeKnowledgeRetrieval` from `service/retrievalExecution.ts:35-341` at a
/// fixed instant.
pub fn execute_knowledge_retrieval_at(
    args: &ExecuteKnowledgeRetrievalArgs<'_>,
    now_ms: f64,
) -> RetrievalResult<KnowledgeRetrievalResult> {
    let input = args.input;
    let options = args.options;

    let memory_service = options
        .memory_service_provider
        .and_then(|provider| provider.current())
        .or(options.memory_service);
    let mut plan = plan_knowledge_query(&input.query);
    let rules_intent = is_rules_intent(&input.query);
    let topic_filter = plan.topic.clone().filter(|topic| topic != "ausgehandelt");
    let strict_topic_filter_requested = topic_filter.is_some();

    let graph_filter = EntityGraphFilter {
        user_id: input.user_id.clone(),
        persona_id: input.persona_id.clone(),
        ..EntityGraphFilter::default()
    };

    let preflight: RetrievalResult<(Option<String>, String)> = (|| {
        if let Some(counterpart) = plan.counterpart.clone() {
            if let Some(entity_match) = options
                .knowledge_repository
                .resolve_entity(&counterpart, &graph_filter)?
            {
                plan.resolved_entity_id = Some(entity_match.entity.id.clone());
                plan.resolved_entity_name = Some(entity_match.entity.canonical_name.clone());
                let mut alias_names = vec![entity_match.entity.canonical_name.clone()];
                if let Some(with_relations) = options
                    .knowledge_repository
                    .get_entity_with_relations(&entity_match.entity.id)?
                {
                    for alias in &with_relations.aliases {
                        alias_names.push(alias.alias.clone());
                    }
                }
                plan.counterpart_aliases = Some(alias_names);
                if let Some(filter) = plan.event_filter.as_mut() {
                    filter.counterpart_entity = Some(entity_match.entity.canonical_name.clone());
                }
            }
        }

        let computed_answer_text = compute_count_recall_answer(
            &plan,
            &input.user_id,
            &input.persona_id,
            options.knowledge_repository,
        )?;
        let entity_context_section = resolve_entity_context(
            &plan,
            &input.user_id,
            &input.persona_id,
            options.knowledge_repository,
        )?;

        Ok((computed_answer_text, entity_context_section))
    })();
    let (computed_answer_text, entity_context_section) = preflight?;

    let base_filter = crate::knowledge::repository::ListKnowledgeFilter {
        user_id: input.user_id.clone(),
        persona_id: input.persona_id.clone(),
        counterpart: plan.counterpart.clone(),
        topic_key: topic_filter,
        from: plan.time_range.as_ref().map(|range| range.from.clone()),
        to: plan.time_range.as_ref().map(|range| range.to.clone()),
        limit: Some(8),
    };

    let mut stage_stats: BTreeMap<String, f64> = BTreeMap::new();
    for key in ["ledger", "episodes", "semantic", "evidence", "graphRules"] {
        stage_stats.insert(key.to_string(), 0.0);
    }

    let attempt: RetrievalResult<KnowledgeRetrievalResult> = (|| {
        let mut ledger_rows: Vec<MeetingLedgerEntry> = options
            .knowledge_repository
            .list_meeting_ledger(&base_filter)?;
        let mut episodes: Vec<KnowledgeEpisode> =
            options.knowledge_repository.list_episodes(&base_filter)?;
        let mut used_topic_fallback = false;

        if strict_topic_filter_requested && ledger_rows.is_empty() && episodes.is_empty() {
            let relaxed_filter = crate::knowledge::repository::ListKnowledgeFilter {
                topic_key: None,
                ..base_filter.clone()
            };
            ledger_rows = options
                .knowledge_repository
                .list_meeting_ledger(&relaxed_filter)?;
            episodes = options
                .knowledge_repository
                .list_episodes(&relaxed_filter)?;
            used_topic_fallback = true;
        }

        let stored_persona_type = match options.get_persona_memory_type {
            Some(lookup) => lookup.get_persona_memory_type(&input.persona_id)?,
            None => None,
        };
        let effective_persona_type = stored_persona_type.unwrap_or(MemoryPersonaType::General);

        if plan.counterpart.is_none() {
            let mut candidates: Vec<String> = Vec::new();
            for row in &ledger_rows {
                candidates.push(
                    row.counterpart
                        .clone()
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                );
            }
            for row in &episodes {
                candidates.push(
                    row.counterpart
                        .clone()
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                );
            }
            let counterpart_candidates = unique_strings(candidates);
            if let Some(mentioned) =
                detect_mentioned_counterpart(&input.query, &counterpart_candidates)
            {
                ledger_rows
                    .retain(|row| is_counterpart_match(row.counterpart.as_deref(), &mentioned));
                episodes.retain(|row| is_counterpart_match(row.counterpart.as_deref(), &mentioned));
            }
        }

        ledger_rows = rank_ledger_by_query_at(&ledger_rows, &input.query, now_ms)
            .into_iter()
            .take(8)
            .collect();
        episodes =
            rank_episodes_by_query_at(&episodes, &input.query, effective_persona_type, now_ms)
                .into_iter()
                .take(8)
                .collect();
        let mut fallback_rule_evidence: Vec<RuleEvidenceEntry> = Vec::new();

        if rules_intent {
            let rule_ledger: Vec<MeetingLedgerEntry> = ledger_rows
                .iter()
                .filter(|row| {
                    if !has_valid_source_refs(Some(&row.source_refs)) {
                        return false;
                    }
                    let mut values = row.decisions.clone();
                    values.extend(row.negotiated_terms.clone());
                    values.extend(row.open_points.clone());
                    values.extend(row.action_items.clone());
                    has_rule_like_fragments(&values)
                })
                .cloned()
                .collect();
            let rule_episodes: Vec<KnowledgeEpisode> = episodes
                .iter()
                .filter(|row| {
                    if !has_valid_source_refs(Some(&row.source_refs)) {
                        return false;
                    }
                    let mut values = vec![
                        row.topic_key.clone(),
                        row.teaser.clone(),
                        row.episode.clone(),
                    ];
                    values.extend(row.facts.clone());
                    has_rule_like_fragments(&values)
                })
                .cloned()
                .collect();
            ledger_rows = rule_ledger;
            episodes = rule_episodes;

            let fallback_entities = options
                .knowledge_repository
                .list_entities(&graph_filter, Some(100))?
                .unwrap_or_default();
            let fallback_events = options
                .knowledge_repository
                .list_events(
                    &KnowledgeEventFilter {
                        user_id: input.user_id.clone(),
                        persona_id: input.persona_id.clone(),
                        from: plan.time_range.as_ref().map(|range| range.from.clone()),
                        to: plan.time_range.as_ref().map(|range| range.to.clone()),
                        ..KnowledgeEventFilter::default()
                    },
                    Some(120),
                )?
                .unwrap_or_default();
            fallback_rule_evidence =
                collect_rule_fallback_evidence(&fallback_entities, &fallback_events);
            stage_stats.insert(
                "graphRules".to_string(),
                fallback_rule_evidence.len() as f64,
            );
        }

        stage_stats.insert("ledger".to_string(), ledger_rows.len() as f64);
        stage_stats.insert("episodes".to_string(), episodes.len() as f64);
        stage_stats.insert(
            "topicFallback".to_string(),
            if used_topic_fallback { 1.0 } else { 0.0 },
        );

        let include_semantic = input.include_semantic != Some(false);
        let semantic = match (include_semantic, memory_service) {
            (true, Some(service)) => service.recall_detailed(
                &input.persona_id,
                &input.query,
                Some(3),
                Some(&input.user_id),
                Some(&MemoryRecallOptions {
                    mode: None,
                    memory_types: input.memory_types.clone(),
                }),
            )?,
            _ => MemoryRecallResult::empty(),
        };
        stage_stats.insert("semantic".to_string(), semantic.matches.len() as f64);
        let semantic_context = build_semantic_context_for_query(&input.query, &semantic);

        let has_signals = stage_stats.get("ledger").copied().unwrap_or(0.0) > 0.0
            || stage_stats.get("episodes").copied().unwrap_or(0.0) > 0.0
            || stage_stats.get("graphRules").copied().unwrap_or(0.0) > 0.0
            || stage_stats.get("semantic").copied().unwrap_or(0.0) > 0.0
            || computed_answer_text.is_some()
            || !entity_context_section.is_empty();

        if !has_signals {
            let _ =
                options
                    .knowledge_repository
                    .insert_retrieval_audit(&InsertRetrievalAuditInput {
                        user_id: input.user_id.clone(),
                        persona_id: input.persona_id.clone(),
                        conversation_id: input
                            .conversation_id
                            .clone()
                            .unwrap_or_else(|| "unknown-conversation".to_string()),
                        query: input.query.clone(),
                        stage_stats: stage_stats.clone(),
                        token_count: 0,
                        had_error: false,
                        error_message: None,
                    });
            if rules_intent {
                return Ok(KnowledgeRetrievalResult {
                    context: String::new(),
                    sections: uncertain_rule_sections(),
                    references: Vec::new(),
                    token_count: 0,
                    computed_answer: None,
                });
            }
            return Ok(KnowledgeRetrievalResult {
                context: String::new(),
                sections: KnowledgeRetrievalSections::default(),
                references: Vec::new(),
                token_count: 0,
                computed_answer: None,
            });
        }

        let conversation_id = select_conversation_id(&episodes, &ledger_rows)
            .or_else(|| input.conversation_id.clone());
        let messages = match &conversation_id {
            Some(id) => options.message_repository.list_messages(
                id,
                Some(200),
                None,
                Some(&input.user_id),
            )?,
            None => Vec::new(),
        };
        stage_stats.insert("evidence".to_string(), messages.len() as f64);

        let extracted =
            extract_counterpart_and_lists(&ledger_rows, &episodes, plan.counterpart.as_deref());
        let merged_key_decisions_list = if rules_intent {
            let mut values = extracted.key_decisions_list.clone();
            values.extend(
                fallback_rule_evidence
                    .iter()
                    .map(|entry| entry.text.clone()),
            );
            unique_strings(values)
        } else {
            extracted.key_decisions_list.clone()
        };

        let filtered = filter_lists_for_rules_intent(
            rules_intent,
            &merged_key_decisions_list,
            &extracted.open_points_list,
        );

        let fallback_rule_highlights: Vec<String> = fallback_rule_evidence
            .iter()
            .map(|entry| entry.text.clone())
            .collect();
        let answer_draft_parts = build_answer_draft(&AnswerDraftInput {
            rules_intent,
            ledger_rows: &ledger_rows,
            episodes: &episodes,
            fallback_rule_highlights: &fallback_rule_highlights,
            counterpart: extracted.counterpart.as_deref(),
            computed_answer_text: computed_answer_text.as_deref(),
            entity_context_section: &entity_context_section,
            semantic_context: &semantic_context,
            key_decisions_list: &filtered.key_decisions,
            open_points_list: &filtered.open_points,
        });

        let extra_refs: Vec<EvidenceSourceRef> = fallback_rule_evidence
            .iter()
            .flat_map(|entry| entry.refs.clone())
            .collect();
        let evidence = build_evidence(
            &messages,
            &episodes,
            &ledger_rows,
            &EvidenceOptions {
                extra_refs,
                allow_message_fallback: !rules_intent,
            },
        );

        let has_rules_evidence = !evidence.references.is_empty();
        let binary_recall_conflict = detect_binary_recall_conflict(&messages, &input.query);

        let raw_sections = if rules_intent && !has_rules_evidence {
            uncertain_rule_sections()
        } else if binary_recall_conflict.has_conflict {
            KnowledgeRetrievalSections {
                answer_draft:
                    "Unklar: In der Historie gibt es widerspruechliche Aussagen zur Frage."
                        .to_string(),
                key_decisions:
                    "Widerspruch erkannt: Nutzer- und Assistant-Aussagen zur gleichen Erinnerung widersprechen sich."
                        .to_string(),
                open_points:
                    "Bitte den Sachverhalt kurz klaeren, damit die Erinnerung stabil wird."
                        .to_string(),
                evidence: if evidence.evidence_text.is_empty() {
                    "Widerspruch erkannt, aber keine Evidenzzeilen verfuegbar.".to_string()
                } else {
                    evidence.evidence_text.clone()
                },
            }
        } else {
            let key_decisions = filtered.key_decisions.join("\n").trim().to_string();
            let open_points = filtered.open_points.join("\n").trim().to_string();
            KnowledgeRetrievalSections {
                answer_draft: answer_draft_parts.join("\n").trim().to_string(),
                key_decisions: if key_decisions.is_empty() {
                    "Keine belastbaren Entscheidungen gefunden.".to_string()
                } else {
                    key_decisions
                },
                open_points: if open_points.is_empty() {
                    "Keine offenen Punkte erkannt.".to_string()
                } else {
                    open_points
                },
                evidence: if evidence.evidence_text.is_empty() {
                    "Keine direkten Evidenzstellen gefunden.".to_string()
                } else {
                    evidence.evidence_text.clone()
                },
            }
        };

        let budget = calculate_and_apply_budget(
            &raw_sections,
            &BudgetContext {
                query: input.query.clone(),
                counterpart_aliases_length: plan
                    .counterpart_aliases
                    .as_ref()
                    .map(|aliases| aliases.len() as f64)
                    .unwrap_or(0.0),
                stage_stats: stage_stats.clone(),
                computed_answer_text: computed_answer_text.clone(),
                max_context_tokens: args.max_context_tokens,
            },
        );

        let _ = options
            .knowledge_repository
            .insert_retrieval_audit(&InsertRetrievalAuditInput {
                user_id: input.user_id.clone(),
                persona_id: input.persona_id.clone(),
                conversation_id: conversation_id
                    .clone()
                    .or_else(|| input.conversation_id.clone())
                    .unwrap_or_else(|| "unknown-conversation".to_string()),
                query: input.query.clone(),
                stage_stats: stage_stats.clone(),
                token_count: budget.token_count as i64,
                had_error: false,
                error_message: None,
            });

        Ok(KnowledgeRetrievalResult {
            context: budget.context.clone(),
            sections: budget.budgeted_sections.clone(),
            references: if rules_intent && !has_rules_evidence {
                Vec::new()
            } else {
                evidence.references.clone()
            },
            token_count: budget.token_count as i64,
            computed_answer: computed_answer_text.clone(),
        })
    })();

    match attempt {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ =
                options
                    .knowledge_repository
                    .insert_retrieval_audit(&InsertRetrievalAuditInput {
                        user_id: input.user_id.clone(),
                        persona_id: input.persona_id.clone(),
                        conversation_id: input
                            .conversation_id
                            .clone()
                            .unwrap_or_else(|| "unknown-conversation".to_string()),
                        query: input.query.clone(),
                        stage_stats: stage_stats.clone(),
                        token_count: 0,
                        had_error: true,
                        error_message: Some(error.message.clone()),
                    });
            Ok(KnowledgeRetrievalResult {
                context: String::new(),
                sections: KnowledgeRetrievalSections::default(),
                references: Vec::new(),
                token_count: 0,
                computed_answer: None,
            })
        }
    }
}

/// `executeKnowledgeRetrieval` from `service/retrievalExecution.ts:35-341`.
pub fn execute_knowledge_retrieval(
    args: &ExecuteKnowledgeRetrievalArgs<'_>,
) -> RetrievalResult<KnowledgeRetrievalResult> {
    execute_knowledge_retrieval_at(args, now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::repository::{KnowledgeSourceRef, RetrievalAuditEntry};
    use crate::knowledge::retrieval::types::{
        MessageLookupRepository, RetrievalKnowledgeRepository,
    };
    use crate::messages_store::StoredMessage;

    const NOW: f64 = 1_718_447_400_000.0;

    #[derive(Default)]
    struct FakeRepo {
        ledger: Vec<MeetingLedgerEntry>,
        episodes: Vec<KnowledgeEpisode>,
        fail_resolve: bool,
        audited_error: std::cell::Cell<bool>,
    }

    impl RetrievalKnowledgeRepository for FakeRepo {
        fn list_meeting_ledger(
            &self,
            _filter: &crate::knowledge::repository::ListKnowledgeFilter,
        ) -> RetrievalResult<Vec<MeetingLedgerEntry>> {
            Ok(self.ledger.clone())
        }
        fn list_episodes(
            &self,
            _filter: &crate::knowledge::repository::ListKnowledgeFilter,
        ) -> RetrievalResult<Vec<KnowledgeEpisode>> {
            Ok(self.episodes.clone())
        }
        fn insert_retrieval_audit(
            &self,
            input: &InsertRetrievalAuditInput,
        ) -> RetrievalResult<RetrievalAuditEntry> {
            self.audited_error.set(input.had_error);
            Ok(RetrievalAuditEntry {
                id: "audit".into(),
                user_id: input.user_id.clone(),
                persona_id: input.persona_id.clone(),
                conversation_id: input.conversation_id.clone(),
                query: input.query.clone(),
                stage_stats: input.stage_stats.clone(),
                token_count: input.token_count,
                had_error: input.had_error,
                error_message: input.error_message.clone(),
                created_at: String::new(),
            })
        }

        fn resolve_entity(
            &self,
            _text: &str,
            _filter: &EntityGraphFilter,
        ) -> RetrievalResult<Option<crate::knowledge::entity_graph::EntityLookupResult>> {
            if self.fail_resolve {
                Err(crate::knowledge::retrieval::types::RetrievalError::new(
                    "storage read failed",
                ))
            } else {
                Ok(None)
            }
        }
    }

    #[derive(Default)]
    struct FakeMessages {
        messages: Vec<StoredMessage>,
        fail: bool,
    }

    impl MessageLookupRepository for FakeMessages {
        fn list_messages(
            &self,
            _conversation_id: &str,
            _limit: Option<i64>,
            _before: Option<&str>,
            _user_id: Option<&str>,
        ) -> RetrievalResult<Vec<StoredMessage>> {
            if self.fail {
                Err(crate::knowledge::retrieval::types::RetrievalError::new(
                    "message read failed",
                ))
            } else {
                Ok(self.messages.clone())
            }
        }
    }

    struct FakeMemory;

    impl crate::knowledge::retrieval::types::MemoryRecall for FakeMemory {
        fn recall_detailed(
            &self,
            _persona_id: &str,
            _query: &str,
            _limit: Option<i64>,
            _user_id: Option<&str>,
            _options: Option<&MemoryRecallOptions>,
        ) -> RetrievalResult<MemoryRecallResult> {
            Err(crate::knowledge::retrieval::types::RetrievalError::new(
                "memory read failed",
            ))
        }
    }

    fn ledger_row() -> MeetingLedgerEntry {
        MeetingLedgerEntry {
            id: "l".into(),
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: "c".into(),
            topic_key: "vertrag".into(),
            counterpart: Some("max".into()),
            event_at: None,
            participants: Vec::new(),
            decisions: vec!["Preis fixiert".into()],
            negotiated_terms: Vec::new(),
            open_points: Vec::new(),
            action_items: Vec::new(),
            source_refs: vec![KnowledgeSourceRef {
                seq: 1,
                quote: "Zitat".into(),
            }],
            confidence: 0.5,
            memory_ids: Vec::new(),
            updated_at: "2024-06-15T10:30:00.000Z".into(),
        }
    }

    fn input(query: &str) -> KnowledgeRetrievalInput {
        KnowledgeRetrievalInput {
            user_id: "u".into(),
            persona_id: "p".into(),
            conversation_id: None,
            query: query.into(),
            include_semantic: Some(false),
            memory_types: None,
        }
    }

    #[test]
    fn without_signals_the_result_is_empty() {
        let repo = FakeRepo {
            ledger: Vec::new(),
            episodes: Vec::new(),
            ..Default::default()
        };
        let messages = FakeMessages::default();
        let options = KnowledgeRetrievalServiceOptions {
            max_context_tokens: 1200,
            knowledge_repository: &repo,
            memory_service: None,
            memory_service_provider: None,
            message_repository: &messages,
            get_persona_memory_type: None,
        };
        let args = ExecuteKnowledgeRetrievalArgs {
            input: &input("die Sauna war warm"),
            options: &options,
            max_context_tokens: 1200.0,
        };
        let result = execute_knowledge_retrieval_at(&args, NOW).expect("retrieval");
        assert_eq!(result.token_count, 0);
        assert!(result.references.is_empty());
        assert_eq!(result.sections.answer_draft, "");
        assert_eq!(result.computed_answer, None);
    }

    #[test]
    fn a_ledger_row_produces_a_draft_and_evidence() {
        let repo = FakeRepo {
            ledger: vec![ledger_row()],
            episodes: Vec::new(),
            ..Default::default()
        };
        let messages = FakeMessages {
            messages: vec![StoredMessage {
                id: "m1".into(),
                conversation_id: "c".into(),
                seq: Some(1),
                role: "agent".into(),
                content: "Es war vereinbart".into(),
                platform: "webchat".into(),
                external_msg_id: None,
                sender_name: None,
                metadata: None,
                created_at: String::new(),
            }],
            fail: false,
        };
        let options = KnowledgeRetrievalServiceOptions {
            max_context_tokens: 1200,
            knowledge_repository: &repo,
            memory_service: None,
            memory_service_provider: None,
            message_repository: &messages,
            get_persona_memory_type: None,
        };
        let args = ExecuteKnowledgeRetrievalArgs {
            input: &input("was war beim vertrag"),
            options: &options,
            max_context_tokens: 1200.0,
        };
        let result = execute_knowledge_retrieval_at(&args, NOW).expect("retrieval");
        assert!(result.token_count > 0);
        assert_eq!(result.references, vec!["seq:1".to_string()]);
        assert!(result.sections.answer_draft.contains("Meeting mit Max"));
        assert!(result.sections.key_decisions.contains("Preis fixiert"));
    }

    #[test]
    fn query_planning_repository_errors_propagate_without_retrieval_audit() {
        let repo = FakeRepo {
            ledger: vec![ledger_row()],
            fail_resolve: true,
            ..Default::default()
        };
        let messages = FakeMessages::default();
        let options = KnowledgeRetrievalServiceOptions {
            max_context_tokens: 1200,
            knowledge_repository: &repo,
            memory_service: None,
            memory_service_provider: None,
            message_repository: &messages,
            get_persona_memory_type: None,
        };
        let args = ExecuteKnowledgeRetrievalArgs {
            input: &input("Was haben wir mit Max besprochen?"),
            options: &options,
            max_context_tokens: 1200.0,
        };

        let error = execute_knowledge_retrieval_at(&args, NOW).expect_err("lookup failure");

        assert_eq!(error.message, "storage read failed");
        assert!(!repo.audited_error.get());
    }

    #[test]
    fn retrieval_message_errors_are_audited_and_return_empty_result() {
        let repo = FakeRepo {
            ledger: vec![ledger_row()],
            ..Default::default()
        };
        let messages = FakeMessages {
            messages: Vec::new(),
            fail: true,
        };
        let options = KnowledgeRetrievalServiceOptions {
            max_context_tokens: 1200,
            knowledge_repository: &repo,
            memory_service: None,
            memory_service_provider: None,
            message_repository: &messages,
            get_persona_memory_type: None,
        };
        let args = ExecuteKnowledgeRetrievalArgs {
            input: &input("was war beim vertrag"),
            options: &options,
            max_context_tokens: 1200.0,
        };

        let result = execute_knowledge_retrieval_at(&args, NOW).expect("caught retrieval error");

        assert!(repo.audited_error.get());
        assert_eq!(result.token_count, 0);
        assert!(result.context.is_empty());
    }

    #[test]
    fn semantic_memory_errors_are_audited_and_return_empty_result() {
        let repo = FakeRepo::default();
        let messages = FakeMessages::default();
        let memory = FakeMemory;
        let options = KnowledgeRetrievalServiceOptions {
            max_context_tokens: 1200,
            knowledge_repository: &repo,
            memory_service: Some(&memory),
            memory_service_provider: None,
            message_repository: &messages,
            get_persona_memory_type: None,
        };
        let mut query = input("die Sauna war warm");
        query.include_semantic = Some(true);
        let args = ExecuteKnowledgeRetrievalArgs {
            input: &query,
            options: &options,
            max_context_tokens: 1200.0,
        };

        let result = execute_knowledge_retrieval_at(&args, NOW).expect("caught retrieval error");

        assert!(repo.audited_error.get());
        assert_eq!(result.token_count, 0);
        assert!(result.context.is_empty());
    }
}
