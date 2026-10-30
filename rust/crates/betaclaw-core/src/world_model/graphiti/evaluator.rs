//! Port of `src/server/world-model/graphiti/evaluator.ts:1-231` — the Graphiti
//! quality gate that compares the derived Graphiti projection with the canonical
//! PostgreSQL rows.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `evaluator.ts:14-36` (`GraphitiEvaluationResult`) | [`GraphitiEvaluationResult`] |
//! | `evaluator.ts:38-46` (`EvaluationTarget`) | `EvaluationTarget` |
//! | `evaluator.ts:48-56` (`expectedNodeUuid`) | [`expected_node_uuid`] |
//! | `evaluator.ts:58-64` (`targetQuery`) | [`target_query`] |
//! | `evaluator.ts:66-72` (`evaluateGraphitiValue`) | [`evaluate_graphiti_value`] |
//! | `evaluator.ts:74-231` (`evaluateGraphitiValueInScope`) | [`evaluate_in_scope`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `runWithWorldModelScope` (`:71`)
//!    reads `getWorldModelScope()`; the port passes the [`WorldModelScope`] it
//!    builds from [`EvaluationScope`].
//! 2. **`checkGraphitiHealth()` is supplied as a parameter.** The free function
//!    is not part of the ported client surface; the caller passes the
//!    [`GraphitiHealthStatus`] it obtained from the client.
//! 3. **`GraphitiRestClient` arrives through the [`GraphitiFactSearch`] seam.**
//!    `searchGraphitiFactsWithRerank` is called on that trait, which the client
//!    implements, so tests can substitute a stub.
//! 4. **`retrievalK` is a parameter.** `:80` reads `GRAPHITI_SEARCH_RESULTS` from
//!    the process environment; the caller resolves it.
//! 5. A failing statement inside the gate keeps the source's catch-all: the
//!    result is returned with `graphiti_reachable = false`,
//!    `recommendation = fallback` and the error text.

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::graphiti::client::{graphiti_group_id, GraphitiHealthStatus};
use crate::world_model::graphiti::retrieval::{
    is_relevant_ranked_graphiti_fact, rank_graphiti_facts, search_graphiti_facts_with_rerank,
    GraphitiFactSearch, GraphitiQueryInput, GraphitiRerankOptions,
};
use crate::world_model::repositories::{ambient_query, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;

/// `recommendation: 'enable' | 'shadow' | 'fallback'` from `:34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationRecommendation {
    Enable,
    Shadow,
    Fallback,
}

impl EvaluationRecommendation {
    pub fn as_str(self) -> &'static str {
        match self {
            EvaluationRecommendation::Enable => "enable",
            EvaluationRecommendation::Shadow => "shadow",
            EvaluationRecommendation::Fallback => "fallback",
        }
    }
}

/// `GraphitiEvaluationResult` from `evaluator.ts:14-36`.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphitiEvaluationResult {
    pub graphiti_reachable: bool,
    pub shadow_edge_count: f64,
    pub structured_hit_count: usize,
    pub evaluated_target_count: usize,
    pub graphiti_fact_count: usize,
    pub relevant_fact_count: usize,
    pub matched_structured_count: usize,
    pub provenance_match_count: usize,
    pub retrieval_k: i64,
    pub precision: f64,
    pub recall: f64,
    pub precision_at1: f64,
    pub recall_at1: f64,
    pub precision_at3: f64,
    pub recall_at3: f64,
    pub precision_at_k: f64,
    pub recall_at_k: f64,
    pub mrr: f64,
    pub overlap_rate: f64,
    pub recommendation: EvaluationRecommendation,
    pub error: Option<String>,
}

/// The `{ userId, personaId, workspaceId }` input of `:66-70`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationScope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

/// `EvaluationTarget` from `evaluator.ts:38-46`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EvaluationTarget {
    target_id: String,
    target_kind: String,
    text: String,
    terms: Vec<String>,
    aliases: Vec<String>,
    source_name: Option<String>,
    target_name: Option<String>,
}

/// The `side` of `expectedNodeUuid` — `:48-56`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeSide {
    Source,
    Target,
}

/// `expectedNodeUuid(target, groupId, side)` — `evaluator.ts:48-56`.
fn expected_node_uuid(target: &EvaluationTarget, group_id: &str, side: NodeSide) -> Option<String> {
    let name = match side {
        NodeSide::Source => target.source_name.as_deref(),
        NodeSide::Target => target.target_name.as_deref(),
    };
    if name.is_none() || target.target_kind != "assertion" {
        return None;
    }
    let prefix = match side {
        NodeSide::Source => "ent",
        NodeSide::Target => "obj",
    };
    Some(format!("{prefix}:{}:{group_id}", name.unwrap_or_default()))
}

/// `targetQuery(target)` — `evaluator.ts:58-64`.
fn target_query(target: &EvaluationTarget) -> GraphitiQueryInput {
    GraphitiQueryInput {
        text: target.text.clone(),
        terms: target.terms.clone(),
        aliases: target.aliases.clone(),
    }
}

/// The `COUNT(*)` of `evaluator.ts:107-111`.
const SQL_SHADOW_COUNT: &str = "SELECT COUNT(*) AS count FROM world_model_graphiti_shadow\n       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3";

/// The target selection of `evaluator.ts:114-159`.
const SQL_EVALUATION_TARGETS: &str = "SELECT target_id AS \"targetId\", target_kind AS \"targetKind\", text, terms, aliases,\n              source_name AS \"sourceName\", target_name AS \"targetName\"\n       FROM (\n         SELECT a.id::text AS target_id,\n           'assertion'::text AS target_kind,\n           CONCAT_WS(' ', s.canonical_name, a.predicate,\n             COALESCE(a.object_value, o.canonical_name)) AS text,\n           ARRAY_REMOVE(ARRAY[s.canonical_name, a.predicate, a.object_value, o.canonical_name], NULL::text) AS terms,\n           ARRAY(\n             SELECT jsonb_array_elements_text(\n               CASE WHEN jsonb_typeof(s.properties->'aliases') = 'array'\n                 THEN s.properties->'aliases' ELSE '[]'::jsonb END\n             )\n           ) || ARRAY(\n             SELECT jsonb_array_elements_text(\n               CASE WHEN jsonb_typeof(o.properties->'aliases') = 'array'\n                 THEN o.properties->'aliases' ELSE '[]'::jsonb END\n             )\n           ) AS aliases,\n           s.canonical_name AS source_name,\n           COALESCE(a.object_value, o.canonical_name) AS target_name\n         FROM world_model_assertions a\n         JOIN world_model_entities s ON s.id = a.subject_id\n         LEFT JOIN world_model_entities o ON o.id = a.object_id\n         WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3\n           AND a.status = 'active' AND a.known_to IS NULL\n         UNION ALL\n         SELECT e.id::text, 'event'::text,\n           CONCAT_WS(' ', e.title, e.event_type),\n           ARRAY_REMOVE(ARRAY[e.title, e.event_type], NULL::text),\n           ARRAY[]::text[], NULL::text, NULL::text\n         FROM world_model_events e\n         WHERE e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3\n           AND e.status NOT IN ('completed', 'cancelled', 'no_show')\n         UNION ALL\n         SELECT t.id::text, 'task'::text, t.title,\n           ARRAY_REMOVE(ARRAY[t.title], NULL::text),\n           ARRAY[]::text[], NULL::text, NULL::text\n         FROM world_model_tasks t\n         WHERE t.user_id = $1 AND t.persona_id = $2 AND t.workspace_id = $3\n           AND t.status NOT IN ('completed', 'cancelled')\n       ) targets\n       WHERE text IS NOT NULL AND text <> ''\n       ORDER BY text\n       LIMIT 50";

/// A `text[]` column read as a string list (the driver decodes it to `Array`).
fn row_text_array(row: &PgRow, column: &str) -> Vec<String> {
    match row.get(column) {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

impl GraphitiEvaluationResult {
    /// The `base` literal of `evaluator.ts:82-104`.
    fn base(health: &GraphitiHealthStatus, retrieval_k: i64) -> Self {
        Self {
            graphiti_reachable: health.reachable,
            shadow_edge_count: 0.0,
            structured_hit_count: 0,
            evaluated_target_count: 0,
            graphiti_fact_count: 0,
            relevant_fact_count: 0,
            matched_structured_count: 0,
            provenance_match_count: 0,
            retrieval_k,
            precision: 0.0,
            recall: 0.0,
            precision_at1: 0.0,
            recall_at1: 0.0,
            precision_at3: 0.0,
            recall_at3: 0.0,
            precision_at_k: 0.0,
            recall_at_k: 0.0,
            mrr: 0.0,
            overlap_rate: 0.0,
            recommendation: if health.reachable {
                EvaluationRecommendation::Shadow
            } else {
                EvaluationRecommendation::Fallback
            },
            error: health.error.clone(),
        }
    }
}

/// The `{ returned, relevant, matched }` of `evaluator.ts:171-175`.
#[derive(Debug, Clone, Copy, Default)]
struct TopKStats {
    returned: i64,
    relevant: i64,
    matched: i64,
}

/// `evaluateGraphitiValue(input)` — `evaluator.ts:66-72`.
pub async fn evaluate_graphiti_value(
    executor: &dyn PgExecutor,
    search: &dyn GraphitiFactSearch,
    health: &GraphitiHealthStatus,
    input: &EvaluationScope,
    retrieval_k: i64,
) -> GraphitiEvaluationResult {
    let scope = WorldModelScope::new(
        &input.user_id,
        &input.persona_id,
        Some(input.workspace_id.clone()),
    );
    let mut base = GraphitiEvaluationResult::base(health, retrieval_k);
    if let Err(error) = evaluate_in_scope(executor, search, health, input, &scope, &mut base).await
    {
        base.graphiti_reachable = false;
        base.recommendation = EvaluationRecommendation::Fallback;
        base.error = Some(error.message);
    }
    base
}

/// `evaluateGraphitiValueInScope(input)` — `evaluator.ts:74-231`.
async fn evaluate_in_scope(
    executor: &dyn PgExecutor,
    search: &dyn GraphitiFactSearch,
    health: &GraphitiHealthStatus,
    input: &EvaluationScope,
    scope: &WorldModelScope,
    base: &mut GraphitiEvaluationResult,
) -> Result<(), PgError> {
    let params = vec![
        PgValue::text(input.user_id.as_str()),
        PgValue::text(input.persona_id.as_str()),
        PgValue::text(input.workspace_id.as_str()),
    ];
    let shadow = ambient_query::<PgError>(
        executor,
        Some(scope),
        PgStatement::with_params(SQL_SHADOW_COUNT, params.clone()),
    )
    .await?;
    base.shadow_edge_count = shadow
        .first()
        .map(|row| crate::js::js_number_str(&row_text(row, "count")))
        .unwrap_or(0.0);

    let target_rows = ambient_query::<PgError>(
        executor,
        Some(scope),
        PgStatement::with_params(SQL_EVALUATION_TARGETS, params),
    )
    .await?;
    let targets: Vec<EvaluationTarget> = target_rows
        .rows
        .iter()
        .map(|row| EvaluationTarget {
            target_id: row_text(row, "targetId"),
            target_kind: row_text(row, "targetKind"),
            text: row_text(row, "text"),
            terms: row_text_array(row, "terms"),
            aliases: row_text_array(row, "aliases"),
            source_name: row_optional_text(row, "sourceName"),
            target_name: row_optional_text(row, "targetName"),
        })
        .collect();
    base.structured_hit_count = targets.len();
    base.evaluated_target_count = targets.len();
    if !health.reachable || targets.is_empty() {
        return Ok(());
    }

    let group_id = graphiti_group_id(&input.user_id, &input.persona_id, &input.workspace_id);
    let retrieval_k = base.retrieval_k;
    let mut matched_facts = 0usize;
    let mut relevant_facts = 0usize;
    let mut provenance_matches = 0usize;
    let mut reciprocal_rank_total = 0.0f64;
    let mut seen_ks = std::collections::HashSet::new();
    let ks: Vec<i64> = [1i64, 3, retrieval_k]
        .into_iter()
        .filter(|k| seen_ks.insert(*k))
        .collect();
    let mut stats: Vec<(i64, TopKStats)> =
        ks.into_iter().map(|k| (k, TopKStats::default())).collect();

    for target in &targets {
        let query = target_query(target);
        let options = GraphitiRerankOptions {
            max_results: Some(retrieval_k.max(1) as usize),
            expected_source_node_uuid: expected_node_uuid(target, &group_id, NodeSide::Source),
            expected_target_node_uuid: expected_node_uuid(target, &group_id, NodeSide::Target),
            ..GraphitiRerankOptions::default()
        };
        let facts = search_graphiti_facts_with_rerank(search, &group_id, &query, &options).await?;
        let ranked = rank_graphiti_facts(&query, facts, &options);
        base.graphiti_fact_count += ranked.len();

        let relevance: Vec<bool> = ranked
            .iter()
            .map(|candidate| is_relevant_ranked_graphiti_fact(candidate, 0.3))
            .collect();
        let matching = relevance.iter().filter(|relevant| **relevant).count();
        relevant_facts += matching;
        provenance_matches += ranked
            .iter()
            .zip(relevance.iter())
            .filter(|(candidate, relevant)| **relevant && candidate.provenance_match)
            .count();
        if matching > 0 {
            matched_facts += 1;
            if let Some(index) = relevance.iter().position(|relevant| *relevant) {
                reciprocal_rank_total += 1.0 / (index as f64 + 1.0);
            }
        }
        for (k, stat) in stats.iter_mut() {
            let top = &ranked[..ranked.len().min((*k).max(0) as usize)];
            stat.returned += top.len() as i64;
            let top_relevant = top
                .iter()
                .filter(|candidate| is_relevant_ranked_graphiti_fact(candidate, 0.3))
                .count();
            stat.relevant += top_relevant as i64;
            if top_relevant > 0 {
                stat.matched += 1;
            }
        }
    }

    let n = targets.len() as f64;
    base.relevant_fact_count = relevant_facts;
    base.matched_structured_count = matched_facts;
    base.provenance_match_count = provenance_matches;
    let at = |k: i64| -> TopKStats {
        stats
            .iter()
            .find(|(value, _)| *value == k)
            .map(|(_, stat)| *stat)
            .unwrap_or_default()
    };
    let top1 = at(1);
    let top3 = at(3);
    base.recall_at_k = matched_facts as f64 / n;
    base.precision_at_k = if base.graphiti_fact_count > 0 {
        relevant_facts as f64 / base.graphiti_fact_count as f64
    } else {
        0.0
    };
    base.recall_at1 = top1.matched as f64 / n;
    base.precision_at1 = if top1.returned > 0 {
        top1.relevant as f64 / top1.returned as f64
    } else {
        0.0
    };
    base.recall_at3 = top3.matched as f64 / n;
    base.precision_at3 = if top3.returned > 0 {
        top3.relevant as f64 / top3.returned as f64
    } else {
        0.0
    };
    base.mrr = reciprocal_rank_total / n;
    base.recall = base.recall_at_k;
    base.precision = base.precision_at_k;
    base.overlap_rate = base.recall_at_k;
    if base.recall_at_k >= 0.9 && base.precision_at_k >= 0.9 {
        base.recommendation = EvaluationRecommendation::Enable;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, BoxFuture, PgQueryResult, PgRow};
    use crate::world_model::retrieval::index::GraphitiFact;
    use serde_json::json;
    use std::sync::Mutex;

    struct StubSearch {
        facts: Vec<GraphitiFact>,
        calls: Mutex<Vec<String>>,
    }

    impl GraphitiFactSearch for StubSearch {
        fn search_facts<'a>(
            &'a self,
            _group_id: &'a str,
            query: &'a str,
            _max_facts: usize,
        ) -> BoxFuture<'a, Result<Vec<GraphitiFact>, PgError>> {
            Box::pin(async move {
                self.calls.lock().expect("calls").push(query.to_string());
                Ok(self.facts.clone())
            })
        }
    }

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row object").clone()
    }

    fn health(reachable: bool) -> GraphitiHealthStatus {
        GraphitiHealthStatus {
            reachable,
            latency_ms: 0,
            error: None,
        }
    }

    fn scope() -> EvaluationScope {
        EvaluationScope {
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: "w1".into(),
        }
    }

    fn target_row() -> PgRow {
        row(json!({
            "targetId": "a1", "targetKind": "assertion", "text": "Mira likes Kino",
            "terms": ["Mira", "Kino"], "aliases": [],
            "sourceName": "Mira", "targetName": "Kino"
        }))
    }

    #[test]
    fn expected_node_uuid_only_exists_for_assertions_with_a_name() {
        let target = EvaluationTarget {
            target_id: "a1".into(),
            target_kind: "assertion".into(),
            text: "Mira likes Kino".into(),
            terms: vec!["Mira".into(), "Kino".into()],
            aliases: vec![],
            source_name: Some("Mira".into()),
            target_name: Some("Kino".into()),
        };
        assert_eq!(
            expected_node_uuid(&target, "g", NodeSide::Source).as_deref(),
            Some("ent:Mira:g")
        );
        assert_eq!(
            expected_node_uuid(&target, "g", NodeSide::Target).as_deref(),
            Some("obj:Kino:g")
        );
        let event = EvaluationTarget {
            target_kind: "event".into(),
            ..target.clone()
        };
        assert_eq!(expected_node_uuid(&event, "g", NodeSide::Source), None);
    }

    #[test]
    fn an_unreachable_graphiti_returns_the_canonical_hits_without_searching() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![row(json!({ "count": "0" }))])),
            Ok(PgQueryResult::from_rows(vec![target_row()])),
        ]);
        let search = StubSearch {
            facts: vec![],
            calls: Mutex::new(vec![]),
        };
        let result = drive_sync(evaluate_graphiti_value(
            &executor,
            &search,
            &health(false),
            &scope(),
            5,
        ))
        .expect("bridge");
        assert!(!result.graphiti_reachable);
        assert_eq!(result.recommendation, EvaluationRecommendation::Fallback);
        assert_eq!(result.structured_hit_count, 1);
        assert_eq!(result.graphiti_fact_count, 0);
        assert!(search.calls.lock().expect("calls").is_empty());
    }

    #[test]
    fn a_matching_fact_scores_a_perfect_recommendation() {
        let group_id = graphiti_group_id("u1", "p1", "w1");
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![row(json!({ "count": "3" }))])),
            Ok(PgQueryResult::from_rows(vec![target_row()])),
        ]);
        let search = StubSearch {
            facts: vec![GraphitiFact {
                fact: "Mira likes Kino".into(),
                source_node_uuid: Some(format!("ent:Mira:{group_id}")),
                ..GraphitiFact::default()
            }],
            calls: Mutex::new(vec![]),
        };
        let result = drive_sync(evaluate_graphiti_value(
            &executor,
            &search,
            &health(true),
            &scope(),
            5,
        ))
        .expect("bridge");
        assert!(result.graphiti_reachable);
        assert_eq!(result.shadow_edge_count, 3.0);
        assert_eq!(result.graphiti_fact_count, 1);
        assert_eq!(result.matched_structured_count, 1);
        assert_eq!(result.provenance_match_count, 1);
        assert_eq!(result.recall_at_k, 1.0);
        assert_eq!(result.precision_at_k, 1.0);
        assert_eq!(result.retrieval_k, 5);
        assert_eq!(result.recommendation, EvaluationRecommendation::Enable);
        assert_eq!(result.mrr, 1.0);
        assert!(!search.calls.lock().expect("calls").is_empty());
    }
}
