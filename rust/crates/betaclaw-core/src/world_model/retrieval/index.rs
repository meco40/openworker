//! Port of `src/server/world-model/retrieval/index.ts` (335 lines) and the
//! `metrics.ts` sibling's entry point.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `index.ts:34` (`RetrievalSource`) | [`RetrievalSource`] |
//! | `index.ts:37-49` (`RetrievalContextResult`) | [`RetrievalContextResult`] |
//! | `index.ts:51-64` (`statusFilterForIntent`) | [`status_filter_for_intent`] |
//! | `index.ts:74-82` (`RetrieveContextInput`) | [`RetrieveContextInput`] |
//! | `index.ts:84-93` (`retrieveContext`) | [`retrieve_context`] |
//! | `index.ts:95-288` (`retrieveContextInScope`) | [`retrieve_context`] |
//! | `index.ts:290-348` (`formatWorldModelContext`) | [`format_world_model_context`] |
//!
//! # The ambient scope is the input
//!
//! `retrieveContext` wraps itself in `runWithWorldModelScope({userId, personaId,
//! workspaceId: input.workspaceId ?? ''}, …)` (`index.ts:85-92`). The port keeps
//! that shape without an `AsyncLocalStorage`: [`retrieve_context`] derives the
//! [`NormalizedScope`] from the input's three ids and passes it to **every**
//! lane, so no lane reads a process- or task-local scope
//! (`.tmp/s6s7-plan.md`, rule 7). The three ids of the input *are* the tenant —
//! there is no caller that could ask for a different one.
//!
//! # The injected lanes
//!
//! Four calls leave this slice: the timeline of the structured lane
//! ([`EventTimelineLoader`], P1 repositories), the query embedding
//! ([`QueryEmbedder`], `embeddings/provider.ts`, P5), the Graphiti recall lane
//! ([`GraphitiRecall`], P3) and nothing else — the six SQL lanes are the
//! modules of this package. They travel in one [`RetrievalDeps`] bundle.
//!
//! [`GraphitiFact`] is the reduced port of `graphiti/client.ts:62-70` (the two
//! properties this file reads), because the graphiti package declares the same
//! interface; the parent reconciles the two after the parallel packages land
//! (OP). The `graphitiGroupId` hash is part of the same seam.
//!
//! # Verified TypeScript quirks
//!
//! * The limit is `Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)))`
//!   (`:103`) — the *floor* is why the seven lanes receive an integral limit.
//! * `Promise.all` over the four domain lanes (`:143-180`) rejects on the first
//!   failure and the single `catch` answers `[[], [], [], []]`; the port keeps
//!   the "all or nothing" shape with `tokio::join!` plus one match.
//! * Every lane starts before the first `await` (`:109-216`), so the slowest
//!   source bounds the latency; the port starts them in the same order.
//! * `input.asOfKnownTime ?? plan.asOfKnownTime` (`:120`, `:131`) uses `??`, so
//!   an empty string from the caller wins over the plan.
//! * `term: plan.entity || input.query` (`:113`) uses `||`: an absent *or empty*
//!   entity falls back to the raw query.
//! * `statusFilterForIntent` returns `'attended'` for `what_done`, which the
//!   `EventStatus` union does not contain (`types.ts:10-17`) — the port passes
//!   the literals through as text (see `structured.rs`).
//! * `active: e.status !== 'cancelled' && e.status !== 'no_show'` (`:232`) makes
//!   a `NULL`/unknown status *active*; the full-text and assertion lanes use
//!   `status === 'active'` (`:239`, `:246`), and every vector candidate is
//!   `active: true` (`:253`), which makes the suppression pass a no-op on this
//!   data path even though it is called (`:258`).
//! * `finalRanked[0].source` (`:275`) is read from the **filtered** list.
//! * The graphiti lane needs `graphitiRecallEnabled && graphitiBackendEnabled`
//!   (`:201`); the vector lane returns `[]` when no embedding provider is
//!   configured (`:182-183`).
//! * `formatWorldModelContext` de-duplicates by key in insertion order
//!   (`:293-297`), so the full-text line of an assertion wins over the typed
//!   assertion line (`:308-319`), and `[scheduledFor, endsAt].filter(Boolean)`
//!   drops empty strings, not just `null` (`:299`).
//! * Numbers are interpolated with `String(number)` (`:311`, `:341`), so `0.5`
//!   stays `0.5` and `1` has no `.0`; [`js_number_string`] reproduces that for
//!   the reachable range (see its doc).
//! * Timestamps arrive as `Date#toISOString()` text from the driver
//!   (`world_model/driver.rs:36-38`) where the TypeScript interpolates a `Date`
//!   whose `toString()` is host-timezone dependent
//!   (`tests/unit/world-model/retrieval.test.ts:451` asserts the ISO form).

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{BoxFuture, NormalizedScope, PgError, PgExecutor, QueryEmbedder};
use crate::world_model::types::EventStatus;

use super::assertions::{search_assertions, AssertionRetrievalHit, AssertionRetrievalOptions};
use super::fulltext::{full_text_search_assertions, FullTextHit, FullTextOptions};
use super::hybrid_ranker::{
    hybrid_rank, suppress_inactive_before_lower_source, RankCandidate, RankSource,
};
use super::open_loops::{search_open_loops, OpenLoopRetrievalHit, OpenLoopRetrievalOptions};
use super::query_planner::{plan_query, PlannedQuery, QueryIntent, QueryPlanInput};
use super::relations::{search_relations, RelationRetrievalHit, RelationRetrievalOptions};
use super::structured::{
    find_structured_events, EventTimelineLoader, FindStructuredEventsOptions, StructuredEventHit,
};
use super::tasks::{search_tasks, TaskRetrievalHit, TaskRetrievalOptions};
use super::vector::{vector_search, VectorHit, VectorTargetFilter};

/// `RetrievalSource` from `index.ts:34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetrievalSource {
    Structured,
    Fulltext,
    Vector,
    Graphiti,
    None,
}

/// The `source` of a [`RetrievalContextResult`] as the ranked hit carries it.
fn source_of(rank_source: RankSource) -> RetrievalSource {
    match rank_source {
        RankSource::Structured => RetrievalSource::Structured,
        RankSource::Fulltext => RetrievalSource::Fulltext,
        RankSource::Vector => RetrievalSource::Vector,
    }
}

/// `GraphitiFact` from `graphiti/client.ts:62-70`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphitiFact {
    pub uuid: Option<String>,
    pub name: Option<String>,
    pub fact: String,
    pub valid_at: Option<String>,
    pub invalid_at: Option<String>,
    pub source_node_uuid: Option<String>,
    pub target_node_uuid: Option<String>,
}

/// `graphitiGroupId(userId, personaId, workspaceId)` —
/// `graphiti/client.ts:113-116`.
///
/// A transport identifier of the derived projection, not an application scope:
/// the implementation hashes the NUL-joined tenant triple. The graphiti package
/// owns it; the retrieval lane only hands the three ids over.
pub trait GraphitiRecall: Send + Sync {
    /// `graphitiGroupId(userId, personaId, workspaceId)` — `client.ts:113-116`.
    fn group_id(&self, user_id: &str, persona_id: &str, workspace_id: &str) -> String;

    /// `searchGraphitiFactsWithRerank(groupId, {text, terms}, {maxResults})` —
    /// `graphiti/retrieval.ts:186-216`.
    fn search_with_rerank<'a>(
        &'a self,
        group_id: &'a str,
        request: GraphitiRecallRequest<'a>,
        max_results: i64,
    ) -> BoxFuture<'a, Result<Vec<GraphitiFact>, PgError>>;
}

/// The `input` of `searchGraphitiFactsWithRerank` the retrieval lane builds —
/// `index.ts:205-208`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraphitiRecallRequest<'a> {
    pub text: &'a str,
    pub terms: &'a [String],
}

/// A Graphiti lane that fails every call — the `catch` of `index.ts:211-215`
/// then logs and answers `[]`, which is exactly what a Graphiti backend that is
/// not reachable produces. Rust-only (compare `db::UnconfiguredPgExecutor`).
#[derive(Debug, Clone, Copy, Default)]
pub struct UnwiredGraphitiRecall;

impl GraphitiRecall for UnwiredGraphitiRecall {
    fn group_id(&self, user_id: &str, persona_id: &str, workspace_id: &str) -> String {
        // The NUL-joined tenant triple of `client.ts:114`, without the hash:
        // the group id is opaque to this module and only fed back into the lane.
        format!("{user_id}\0{persona_id}\0{workspace_id}")
    }

    fn search_with_rerank<'a>(
        &'a self,
        _group_id: &'a str,
        _request: GraphitiRecallRequest<'a>,
        _max_results: i64,
    ) -> BoxFuture<'a, Result<Vec<GraphitiFact>, PgError>> {
        Box::pin(async { Err(PgError::new("no Graphiti backend is wired")) })
    }
}

/// The injected collaborators of [`retrieve_context`].
///
/// The executor carries the six SQL lanes of this package; the other three are
/// the calls that leave the package (see the module header).
pub struct RetrievalDeps<'a> {
    pub executor: &'a dyn PgExecutor,
    pub embedder: &'a dyn QueryEmbedder,
    pub timeline: &'a dyn EventTimelineLoader,
    pub graphiti: &'a dyn GraphitiRecall,
}

/// `RetrievalContextResult` from `index.ts:37-49`.
///
/// The five optional fields are present on the success path (possibly empty)
/// and absent on the disabled path (`index.ts:100`), which is why they are
/// `Option`.
#[derive(Debug, Clone, PartialEq)]
pub struct RetrievalContextResult {
    pub structured: Vec<StructuredEventHit>,
    pub full_text: Vec<FullTextHit>,
    pub vector: Vec<VectorHit>,
    pub source: RetrievalSource,
    pub enabled: bool,
    pub assertions: Option<Vec<AssertionRetrievalHit>>,
    pub tasks: Option<Vec<TaskRetrievalHit>>,
    pub relations: Option<Vec<RelationRetrievalHit>>,
    pub open_loops: Option<Vec<OpenLoopRetrievalHit>>,
    pub graphiti: Option<Vec<GraphitiFact>>,
}

/// `RetrieveContextInput` from `index.ts:74-82`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetrieveContextInput {
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — the scope fills `''` for it (`:89`).
    pub workspace_id: Option<String>,
    pub query: String,
    pub limit: Option<i64>,
    pub as_of_known_time: Option<String>,
    pub as_of_valid_time: Option<String>,
}

impl RetrieveContextInput {
    /// The scope of `runWithWorldModelScope` — `index.ts:86-90`.
    pub fn scope(&self) -> NormalizedScope {
        NormalizedScope {
            user_id: self.user_id.clone(),
            persona_id: self.persona_id.clone(),
            workspace_id: self.workspace_id.clone().unwrap_or_default(),
        }
    }
}

/// `statusFilterForIntent` — `index.ts:51-64`.
///
/// Returns the literals as text: the `what_done` list contains `'attended'`,
/// which is not a member of the `EventStatus` union (`types.ts:10-17`).
pub fn status_filter_for_intent(intent: QueryIntent) -> Option<Vec<String>> {
    let values: &[&str] = match intent {
        QueryIntent::WhatDone => &["completed", "attended"],
        QueryIntent::WhatPlanned => &["planned", "proposed", "in_progress"],
        QueryIntent::WhatCancelled => &["cancelled", "no_show"],
        QueryIntent::WhatOpen => &["planned", "proposed", "in_progress"],
        _ => return None,
    };
    Some(values.iter().map(|value| (*value).to_string()).collect())
}

/// `console.error(label, error)` of the lane catches — `index.ts:122`, `:133`,
/// `:178`, `:196`, `:213`.
fn log_lane_error(label: &str, error: &PgError) {
    tracing::error!(
        target: "world_model::retrieval",
        "[world-model:retrieval] {label}: {}",
        crate::safe_error_message(error)
    );
}

/// The `.catch(() => [])` of one lane — `index.ts:121-124`, `:132-135`.
async fn catching<T>(
    future: impl std::future::Future<Output = Result<Vec<T>, PgError>>,
    label: &'static str,
) -> Vec<T> {
    match future.await {
        Ok(values) => values,
        Err(error) => {
            log_lane_error(label, &error);
            Vec::new()
        }
    }
}

/// `retrieveContext(input)` — `index.ts:84-288`.
///
/// The five lanes start in source order and are joined together, so
/// canonical-recall latency is bounded by the slowest source. The four typed
/// domain lanes follow the `Promise.all` contract of `:143-180`: a single
/// failure discards all four.
pub async fn retrieve_context(
    config: &WorldModelConfig,
    deps: &RetrievalDeps<'_>,
    input: &RetrieveContextInput,
) -> RetrievalContextResult {
    if !config.enabled && !config.e2e_enabled {
        return RetrievalContextResult {
            structured: Vec::new(),
            full_text: Vec::new(),
            vector: Vec::new(),
            source: RetrievalSource::None,
            enabled: false,
            assertions: None,
            tasks: None,
            relations: None,
            open_loops: None,
            graphiti: None,
        };
    }

    let scope = input.scope();
    // `Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)))` — `:103`.
    let limit = input.limit.unwrap_or(5).clamp(1, 50);
    let plan: PlannedQuery = plan_query(&QueryPlanInput {
        text: input.query.clone(),
        now: None,
    });
    // `plan.entity || input.query` — an empty entity is falsy (`:113`).
    let term = plan
        .entity
        .clone()
        .filter(|entity| !entity.is_empty())
        .unwrap_or_else(|| input.query.clone());
    // `input.asOfKnownTime ?? plan.asOfKnownTime` — `??`, so `Some("")` wins.
    let known_as_of = input
        .as_of_known_time
        .clone()
        .or_else(|| plan.as_of_known_time.clone());
    let valid_as_of = input
        .as_of_valid_time
        .clone()
        .or_else(|| plan.as_of_valid_time.clone());

    let structured_options = FindStructuredEventsOptions {
        term: term.clone(),
        limit: Some(limit),
        time_window: plan.time_window.clone(),
        status_filter: status_filter_for_intent(plan.intent),
        valid_as_of: valid_as_of.clone(),
        known_as_of: known_as_of.clone(),
    };
    let structured_future =
        find_structured_events(deps.executor, deps.timeline, &scope, &structured_options);
    let full_text_options = FullTextOptions {
        known_as_of: known_as_of.clone(),
    };
    let full_text_future = catching(
        full_text_search_assertions(
            deps.executor,
            &scope,
            &input.query,
            limit,
            &full_text_options,
        ),
        "full-text search failed",
    );
    let assertion_options = AssertionRetrievalOptions {
        status: None,
        known_as_of: known_as_of.clone(),
        valid_as_of: valid_as_of.clone(),
        query: Some(term.clone()),
        limit: Some(limit),
    };
    let task_options = TaskRetrievalOptions {
        status: None,
        overdue: false,
        limit: Some(limit),
        query: Some(term.clone()),
        known_as_of: known_as_of.clone(),
    };
    let relation_options = RelationRetrievalOptions {
        relation_type: None,
        entity_name: Some(term.clone()),
        // Match `index.ts`: the relations lane receives the plan's valid-time only.
        valid_as_of: plan.as_of_valid_time.clone(),
        known_as_of: known_as_of.clone(),
        limit: Some(limit),
    };
    let open_loop_options = OpenLoopRetrievalOptions {
        query: Some(term.clone()),
        limit: Some(limit),
    };
    let domain_future = async {
        tokio::join!(
            search_assertions(deps.executor, config, &scope, &assertion_options,),
            search_tasks(deps.executor, config, &scope, &task_options,),
            search_relations(deps.executor, config, &scope, &relation_options,),
            search_open_loops(deps.executor, config, &scope, &open_loop_options,),
        )
    };
    let vector_future = async {
        // `getConfiguredEmbeddingProvider()` — `Ok(None)` is "no provider".
        match deps.embedder.embed(&input.query).await {
            Ok(None) => Vec::new(),
            Ok(Some(embedding)) => {
                vector_search(
                    deps.executor,
                    config,
                    &scope,
                    &embedding,
                    limit,
                    0.5,
                    VectorTargetFilter {
                        exclude: Some(&["memory"]),
                        ..VectorTargetFilter::default()
                    },
                )
                .await
            }
            Err(error) => {
                tracing::warn!(
                    target: "world_model::retrieval",
                    "[world-model:retrieval] vector search unavailable: {}",
                    crate::safe_error_message(&error)
                );
                Vec::new()
            }
        }
    };
    let graphiti_future = async {
        if !config.graphiti_recall_enabled || !config.graphiti_backend_enabled {
            return Vec::new();
        }
        let group_id =
            deps.graphiti
                .group_id(&input.user_id, &input.persona_id, &scope.workspace_id);
        let terms = vec![term.clone()];
        match deps
            .graphiti
            .search_with_rerank(
                &group_id,
                GraphitiRecallRequest {
                    text: &input.query,
                    terms: &terms,
                },
                limit,
            )
            .await
        {
            Ok(facts) => facts,
            Err(error) => {
                // Graphiti is derived and must never make canonical retrieval
                // fail (`:212-215`).
                tracing::warn!(
                    target: "world_model::retrieval",
                    "[world-model:retrieval] Graphiti recall unavailable: {}",
                    crate::safe_error_message(&error)
                );
                Vec::new()
            }
        }
    };

    let (structured, full_text, domain, vector, graphiti) = tokio::join!(
        catching(structured_future, "structured event search failed"),
        full_text_future,
        domain_future,
        vector_future,
        graphiti_future,
    );
    let (assertions, tasks, relations, open_loops) = match domain {
        (Ok(assertions), Ok(tasks), Ok(relations), Ok(open_loops)) => {
            (assertions, tasks, relations, open_loops)
        }
        (assertions, tasks, relations, open_loops) => {
            // `Promise.all(...).catch(...)` discards every lane when one fails;
            // the port reports the first failure in lane order.
            let first = assertions
                .err()
                .or_else(|| tasks.err())
                .or_else(|| relations.err())
                .or_else(|| open_loops.err());
            if let Some(error) = first {
                log_lane_error("structured domain search failed", &error);
            }
            (Vec::new(), Vec::new(), Vec::new(), Vec::new())
        }
    };

    // `:227-255` — the candidates the hybrid ranker orders. The vector lane
    // contributes `active: true` for every hit.
    let mut candidates: Vec<RankCandidate> = Vec::new();
    let intent = plan.intent.as_str().to_string();
    for event in &structured {
        candidates.push(RankCandidate {
            id: event.id.clone(),
            source: RankSource::Structured,
            score: 1.0,
            active: event.status != EventStatus::Cancelled && event.status != EventStatus::NoShow,
            query_intent: Some(intent.clone()),
        });
    }
    for hit in &full_text {
        candidates.push(RankCandidate {
            id: hit.id.clone(),
            source: RankSource::Fulltext,
            score: 1.0,
            active: hit.status == "active",
            query_intent: Some(intent.clone()),
        });
    }
    for assertion in &assertions {
        candidates.push(RankCandidate {
            id: assertion.id.clone(),
            source: RankSource::Fulltext,
            score: 1.0,
            active: assertion.status == "active",
            query_intent: Some(intent.clone()),
        });
    }
    for hit in &vector {
        candidates.push(RankCandidate {
            id: hit.target_id.clone(),
            source: RankSource::Vector,
            score: hit.similarity,
            active: true,
            query_intent: Some(intent.clone()),
        });
    }

    let ranked = hybrid_rank(&candidates);
    let final_ranked = suppress_inactive_before_lower_source(&ranked, RankSource::Vector);

    let fallback_source = if !structured.is_empty() {
        RetrievalSource::Structured
    } else if !full_text.is_empty()
        || !assertions.is_empty()
        || !tasks.is_empty()
        || !relations.is_empty()
        || !open_loops.is_empty()
    {
        RetrievalSource::Fulltext
    } else if !graphiti.is_empty() {
        RetrievalSource::Graphiti
    } else if !vector.is_empty() {
        RetrievalSource::Vector
    } else {
        RetrievalSource::None
    };
    let source = match final_ranked.first() {
        Some(hit) => source_of(hit.source()),
        None => fallback_source,
    };

    RetrievalContextResult {
        structured,
        full_text,
        vector,
        source,
        enabled: true,
        assertions: Some(assertions),
        tasks: Some(tasks),
        relations: Some(relations),
        open_loops: Some(open_loops),
        graphiti: Some(graphiti),
    }
}

/// `String(number)` for the values `formatWorldModelContext` interpolates.
///
/// `0.5` stays `0.5`, `1` has no `.0`, `-0` is `0`, `NaN`/`Infinity` keep their
/// JavaScript spelling. Rust's `Display` for `f64` is the shortest round-trip
/// representation like `Number::toString`, so the two agree for the reachable
/// range of confidences and similarities (`0..1`); JavaScript switches to the
/// exponent form for `|value| >= 1e21` and for values below `1e-6`, which this
/// port renders in full (deliberate deviation, unreachable — OP).
fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    format!("{value}")
}

/// The union literal of a status — the `#[serde(rename_all = "snake_case")]`
/// name of `types.rs`.
fn status_text(status: EventStatus) -> String {
    match serde_json::to_value(status) {
        Ok(serde_json::Value::String(text)) => text,
        _ => "unknown".to_string(),
    }
}

/// The union literal of a modality — `fulltext.rs` parses it with the same
/// serde mapping.
fn modality_text(modality: crate::world_model::types::Modality) -> String {
    match serde_json::to_value(modality) {
        Ok(serde_json::Value::String(text)) => text,
        _ => "reported".to_string(),
    }
}

/// The de-duplicating `add(key, line)` of `formatWorldModelContext`
/// (`index.ts:293-297`).
fn add_line(seen: &mut Vec<String>, lines: &mut Vec<String>, key: String, line: String) {
    if seen.contains(&key) {
        return;
    }
    seen.push(key);
    lines.push(line);
}

/// `formatWorldModelContext(result)` — `index.ts:290-348`.
///
/// `None` when no line was added, so the caller can skip an empty context. The
/// context is also what `recall/index.ts:142-143` returns as the world-model
/// block of a chat prompt, so the exact line texts matter.
pub fn format_world_model_context(result: &RetrievalContextResult) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for event in &result.structured {
        // `[scheduledFor, endsAt].filter(Boolean).join(' - ')` — falsy values
        // (absent *and* empty) drop out.
        let schedule = [event.scheduled_for.as_deref(), event.ends_at.as_deref()]
            .into_iter()
            .flatten()
            .filter(|value| !value.is_empty())
            .collect::<Vec<&str>>()
            .join(" - ");
        let timeline = event
            .timeline
            .iter()
            .map(
                |point| match point.reason.as_deref().filter(|reason| !reason.is_empty()) {
                    Some(reason) => format!("{} ({reason})", status_text(point.to_status)),
                    None => status_text(point.to_status),
                },
            )
            .collect::<Vec<String>>()
            .join(" -> ");
        let mut line = format!(
            "- Event: {}; status={}",
            event.title,
            status_text(event.status)
        );
        if !schedule.is_empty() {
            line.push_str(&format!("; time={schedule}"));
        }
        if !timeline.is_empty() {
            line.push_str(&format!("; history={timeline}"));
        }
        add_line(&mut seen, &mut lines, format!("event:{}", event.id), line);
    }

    for hit in &result.full_text {
        let mut line = format!(
            "- Assertion [{}]: {} = {}; modality={}; status={}; confidence={}",
            hit.id,
            hit.predicate,
            hit.object_value,
            modality_text(hit.modality),
            hit.status,
            js_number_string(hit.confidence)
        );
        if let Some(source) = hit
            .source_observation_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            line.push_str(&format!("; source={source}"));
        }
        add_line(&mut seen, &mut lines, format!("assertion:{}", hit.id), line);
    }

    for assertion in result.assertions.iter().flatten() {
        let mut line = format!(
            "- Assertion [{}]: {} {} = {}; modality={}; status={}; confidence={}",
            assertion.id,
            assertion.subject_name,
            assertion.predicate,
            // A `null` object value interpolates as the text `null`.
            assertion.object_value.as_deref().unwrap_or("null"),
            assertion.modality,
            assertion.status,
            js_number_string(assertion.confidence)
        );
        if let Some(source) = assertion
            .source_observation_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            line.push_str(&format!("; source={source}"));
        }
        add_line(
            &mut seen,
            &mut lines,
            format!("assertion:{}", assertion.id),
            line,
        );
    }

    for task in result.tasks.iter().flatten() {
        let mut line = format!("- Task: {}; status={}", task.title, task.status);
        if let Some(due_at) = task.due_at.as_deref().filter(|value| !value.is_empty()) {
            line.push_str(&format!("; due={due_at}"));
        }
        add_line(&mut seen, &mut lines, format!("task:{}", task.id), line);
    }

    for relation in result.relations.iter().flatten() {
        add_line(
            &mut seen,
            &mut lines,
            format!("relation:{}", relation.id),
            format!(
                "- Relation [{}]: {} {} {}; confidence={}",
                relation.id,
                relation.source_entity_name,
                relation.relation_type,
                relation.target_entity_name,
                js_number_string(relation.confidence)
            ),
        );
    }

    for open_loop in result.open_loops.iter().flatten() {
        add_line(
            &mut seen,
            &mut lines,
            format!("loop:{}", open_loop.id),
            format!(
                "- Open loop [{}]: {}; status={}; question={}",
                open_loop.id,
                open_loop.loop_type,
                open_loop.status,
                // `loop.question ?? ''` — a `NULL` question is the empty text.
                open_loop.question.as_deref().unwrap_or("")
            ),
        );
    }

    for hit in &result.vector {
        add_line(
            &mut seen,
            &mut lines,
            format!("vector:{}:{}", hit.target_type, hit.target_id),
            format!(
                "- Semantic evidence [{}]: {}; similarity={}",
                hit.target_id,
                hit.text,
                js_number_string(hit.similarity)
            ),
        );
    }

    for fact in result.graphiti.iter().flatten() {
        add_line(
            &mut seen,
            &mut lines,
            format!(
                "graphiti:{}",
                fact.uuid.clone().unwrap_or_else(|| fact.fact.clone())
            ),
            format!("- Graphiti derived fact: {}", fact.fact),
        );
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::structured::{EmptyEventTimeline, EventTimelinePoint};
    use super::super::test_config;
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgStatement, PgValue, SQL_BEGIN};
    use crate::world_model::types::Modality;
    use serde_json::json;
    use std::sync::Mutex;

    /// The `generateEmbeddingOnce` double — `Ok(None)` is "no provider".
    struct FixedEmbedder {
        embedding: Option<Vec<f64>>,
        failure: Option<String>,
        calls: Mutex<Vec<String>>,
    }

    impl FixedEmbedder {
        fn missing() -> Self {
            Self {
                embedding: None,
                failure: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn embedding(values: Vec<f64>) -> Self {
            Self {
                embedding: Some(values),
                failure: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing(message: &str) -> Self {
            Self {
                embedding: None,
                failure: Some(message.to_string()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls mutex").clone()
        }
    }

    impl QueryEmbedder for FixedEmbedder {
        fn embed<'a>(&'a self, text: &'a str) -> BoxFuture<'a, Result<Option<Vec<f64>>, PgError>> {
            self.calls
                .lock()
                .expect("calls mutex")
                .push(text.to_string());
            let embedding = self.embedding.clone();
            let failure = self.failure.clone();
            Box::pin(async move {
                if let Some(message) = failure {
                    return Err(PgError::new(message));
                }
                Ok(embedding)
            })
        }
    }

    /// The `searchGraphitiFactsWithRerank` double.
    struct RecordingGraphiti {
        facts: Vec<GraphitiFact>,
        failure: Option<String>,
        calls: Mutex<Vec<(String, String, i64)>>,
    }

    impl RecordingGraphiti {
        fn new(facts: Vec<GraphitiFact>) -> Self {
            Self {
                facts,
                failure: None,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing(message: &str) -> Self {
            Self {
                facts: Vec::new(),
                failure: Some(message.to_string()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(String, String, i64)> {
            self.calls.lock().expect("calls mutex").clone()
        }
    }

    impl GraphitiRecall for RecordingGraphiti {
        fn group_id(&self, user_id: &str, persona_id: &str, workspace_id: &str) -> String {
            format!("group:{user_id}:{persona_id}:{workspace_id}")
        }

        fn search_with_rerank<'a>(
            &'a self,
            group_id: &'a str,
            request: GraphitiRecallRequest<'a>,
            max_results: i64,
        ) -> BoxFuture<'a, Result<Vec<GraphitiFact>, PgError>> {
            self.calls.lock().expect("calls mutex").push((
                group_id.to_string(),
                request.text.to_string(),
                max_results,
            ));
            let facts = self.facts.clone();
            let failure = self.failure.clone();
            Box::pin(async move {
                if let Some(message) = failure {
                    return Err(PgError::new(message));
                }
                Ok(facts)
            })
        }
    }

    fn input() -> RetrieveContextInput {
        RetrieveContextInput {
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            workspace_id: None,
            query: "Kino".to_string(),
            limit: None,
            as_of_known_time: None,
            as_of_valid_time: None,
        }
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect()
    }

    /// The parameterised statements, without the control statements.
    fn lane_statements(executor: &RecordingExecutor) -> Vec<PgStatement> {
        executor
            .calls()
            .into_iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement)
                    if !statement.params.is_empty()
                        && statement.sql != crate::world_model::db::SQL_SET_SCOPE =>
                {
                    Some(statement)
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_disabled_config_is_fail_closed() {
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::embedding(vec![0.1]);
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = drive_sync(retrieve_context(
            &test_config(false, false),
            &deps,
            &input(),
        ))
        .expect("bridge");
        assert!(!result.enabled);
        assert_eq!(result.source, RetrievalSource::None);
        assert!(result.assertions.is_none());
        assert!(result.graphiti.is_none());
        assert!(executor.calls().is_empty(), "no statement");
        assert!(embedder.calls().is_empty());
        assert!(graphiti.calls().is_empty());
    }

    /// `tests/unit/world-model/retrieval.test.ts:164-168` and `:227-235`.
    #[test]
    fn an_empty_retrieval_reports_none_and_starts_every_lane() {
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = drive_sync(retrieve_context(&test_config(true, false), &deps, &input()))
            .expect("bridge");
        assert!(result.enabled);
        assert_eq!(result.source, RetrievalSource::None);
        assert_eq!(result.assertions, Some(Vec::new()));
        assert_eq!(result.tasks, Some(Vec::new()));
        assert_eq!(result.relations, Some(Vec::new()));
        assert_eq!(result.open_loops, Some(Vec::new()));
        assert_eq!(result.graphiti, Some(Vec::new()));

        // Six SQL lanes: structured, full text, assertions, tasks, relations,
        // open loops — each in its own scoped transaction (`BEGIN` per lane).
        assert_eq!(lane_statements(&executor).len(), 6);
        assert_eq!(
            sqls(&executor)
                .iter()
                .filter(|sql| sql.as_str() == SQL_BEGIN)
                .count(),
            6
        );

        // E2E retrieval opens the same gate (`index.ts:99-101`).
        let e2e_executor = RecordingExecutor::new(Vec::new());
        let e2e_deps = RetrievalDeps {
            executor: &e2e_executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let e2e = drive_sync(retrieve_context(
            &test_config(false, true),
            &e2e_deps,
            &input(),
        ))
        .expect("bridge");
        assert!(e2e.enabled);
        assert!(!e2e_executor.calls().is_empty());
    }

    /// The lanes run in source order: structured, full text, then the four
    /// domain statements (`index.ts:109-216`).
    #[test]
    fn the_lane_order_follows_the_source() {
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        drive_sync(retrieve_context(&test_config(true, false), &deps, &input())).expect("bridge");
        let statements = lane_statements(&executor);
        assert!(statements[0].sql.starts_with("SELECT id, title, status"));
        assert!(statements[1].sql.starts_with("SELECT id, predicate"));
        assert!(statements[2].sql.starts_with("SELECT a.id"));
        assert!(statements[3].sql.starts_with("SELECT t.id"));
        assert!(statements[4].sql.starts_with("SELECT r.id"));
        assert!(statements[5].sql.starts_with("SELECT id, type, status"));
    }

    /// `limit: 80` becomes 50 in every lane (`index.ts:103`).
    #[test]
    fn the_limit_is_bounded_in_every_lane() {
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::embedding(vec![0.5]);
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let mut request = input();
        request.limit = Some(80);
        request.as_of_known_time = Some("2024-01-02T00:00:00.000Z".to_string());
        request.as_of_valid_time = Some("2024-02-03T00:00:00.000Z".to_string());
        retrieve_sync(&deps, &request);

        let statements = lane_statements(&executor);
        // The structured lane clamps in `index.ts`, full text receives 50 and
        // keeps it, and the four domain lanes clamp again (1..50).
        for statement in &statements {
            let limit = if statement.sql.contains("FROM world_model_embeddings e") {
                statement.params.get(5)
            } else {
                statement.params.last()
            };
            assert_eq!(limit, Some(&PgValue::int(50)), "{}", statement.sql);
        }
        // The structured lane carries the caller's as-of values.
        let structured = &statements[0];
        assert!(structured
            .params
            .contains(&PgValue::text("2024-02-03T00:00:00.000Z")));
        assert!(structured
            .params
            .contains(&PgValue::text("2024-01-02T00:00:00.000Z")));
        // The relations lane receives the *plan's* valid-as-of only, which is
        // `None` for a query without an as-of phrase (`index.ts:166`).
        let relations = &statements[4];
        assert!(!relations
            .params
            .contains(&PgValue::text("2024-02-03T00:00:00.000Z")));
    }

    fn retrieve_sync(
        deps: &RetrievalDeps<'_>,
        request: &RetrieveContextInput,
    ) -> RetrievalContextResult {
        drive_sync(retrieve_context(&test_config(true, false), deps, request)).expect("bridge")
    }

    fn event_row(id: &str, status: &str) -> crate::world_model::db::PgRow {
        json!({
            "id": id,
            "title": "Kino",
            "status": status,
            "scheduled_for": null,
            "ends_at": null,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn fulltext_row() -> crate::world_model::db::PgRow {
        json!({
            "id": "a1",
            "predicate": "prefers",
            "object_value": "Kino",
            "modality": "reported",
            "status": "active",
            "confidence": 0.9,
            "source_observation_id": null,
            "known_from": "2025-01-01T00:00:00.000Z",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    /// `tests/unit/world-model/retrieval.test.ts:99-107`.
    #[test]
    fn retains_structured_state_as_the_highest_priority_source() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row("e1", "cancelled")])),
            Ok(PgQueryResult::empty()),
        ]);
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_sync(&deps, &input());
        assert_eq!(result.source, RetrievalSource::Structured);
        assert_eq!(result.structured.len(), 1);
        assert_eq!(result.structured[0].id, "e1");
        assert_eq!(result.structured[0].status, EventStatus::Cancelled);
        // The scope parameters are the input's tenant triple with an empty
        // workspace (`index.ts:89`).
        let scope = input();
        assert_eq!(
            lane_statements(&executor)[0].params[0..3],
            [
                PgValue::text(scope.user_id.as_str()),
                PgValue::text(scope.persona_id.as_str()),
                PgValue::text(""),
            ]
        );
    }

    /// `tests/unit/world-model/retrieval.test.ts:149-162`.
    #[test]
    fn fulltext_rows_select_the_fulltext_source() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![fulltext_row()])),
        ]);
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_sync(&deps, &input());
        assert_eq!(result.source, RetrievalSource::Fulltext);
        assert_eq!(result.full_text.len(), 1);
        assert_eq!(result.full_text[0].modality, Modality::Reported);
    }

    /// `tests/unit/world-model/retrieval.test.ts:128-147` — a failing structured
    /// lane keeps the other lanes.
    #[test]
    fn a_failing_structured_lane_keeps_the_other_lanes() {
        let executor = RecordingExecutor::new(vec![
            Err(PgError::new("events unavailable")),
            Ok(PgQueryResult::from_rows(vec![fulltext_row()])),
        ]);
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_sync(&deps, &input());
        assert!(result.structured.is_empty());
        assert_eq!(result.full_text.len(), 1);
        assert_eq!(result.source, RetrievalSource::Fulltext);
    }

    /// `tests/unit/world-model/retrieval.test.ts:258-272` — one failing domain
    /// lane discards all four.
    #[test]
    fn a_failing_domain_lane_empties_all_four() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Err(PgError::new("relations unavailable")),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
        ]);
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_sync(&deps, &input());
        assert_eq!(result.assertions, Some(Vec::new()));
        assert_eq!(result.tasks, Some(Vec::new()));
        assert_eq!(result.relations, Some(Vec::new()));
        assert_eq!(result.open_loops, Some(Vec::new()));
        assert_eq!(result.source, RetrievalSource::None);
    }

    /// `tests/unit/world-model/retrieval.test.ts:170-186`.
    #[test]
    fn the_vector_lane_uses_the_query_embedding_and_excludes_memory() {
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::embedding(vec![0.1, 0.2]);
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let mut request = input();
        request.workspace_id = Some("w".to_string());
        retrieve_sync(&deps, &request);

        assert_eq!(embedder.calls(), vec!["Kino"]);
        let statements = lane_statements(&executor);
        assert_eq!(statements.len(), 7, "six lanes plus pgvector");
        let vector = &statements[6];
        assert!(vector.sql.contains("embedding <=> $1::vector"));
        assert_eq!(
            vector.params,
            vec![
                PgValue::text("[0.1,0.2]"),
                PgValue::text("u"),
                PgValue::text("p"),
                PgValue::text("w"),
                PgValue::float(0.5),
                PgValue::int(5),
                PgValue::Null,
                PgValue::text_array(vec!["memory".to_string()]),
                PgValue::boolean(false),
            ]
        );
    }

    /// `tests/unit/world-model/retrieval.test.ts:274-300`.
    #[test]
    fn a_failing_embedding_skips_the_vector_lane() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![fulltext_row()])),
        ]);
        let embedder = FixedEmbedder::failing("embedding unavailable");
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        let result = retrieve_sync(&deps, &input());
        assert!(result.vector.is_empty());
        assert_eq!(result.source, RetrievalSource::Fulltext);
        assert!(
            !lane_statements(&executor)
                .iter()
                .any(|statement| statement.sql.contains("world_model_embeddings")),
            "the vector statement is never issued"
        );
    }

    /// `tests/unit/world-model/retrieval.test.ts:302-330` — the Graphiti lane
    /// needs both feature flags and its failure is contained.
    #[test]
    fn graphiti_runs_only_when_both_flags_are_set() {
        let mut config = test_config(true, false);
        config.graphiti_recall_enabled = true;
        let executor = RecordingExecutor::new(Vec::new());
        let embedder = FixedEmbedder::missing();
        let graphiti = RecordingGraphiti::new(Vec::new());
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &graphiti,
        };
        drive_sync(retrieve_context(&config, &deps, &input())).expect("bridge");
        assert!(graphiti.calls().is_empty(), "the backend flag is off");

        config.graphiti_backend_enabled = true;
        let facts = vec![GraphitiFact {
            uuid: Some("fact-1".to_string()),
            fact: "Kino am Freitag".to_string(),
            ..GraphitiFact::default()
        }];
        let called = RecordingGraphiti::new(facts);
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &called,
        };
        let result = drive_sync(retrieve_context(&config, &deps, &input())).expect("bridge");
        assert_eq!(result.source, RetrievalSource::Graphiti);
        assert_eq!(result.graphiti.expect("facts").len(), 1);
        assert_eq!(
            called.calls(),
            vec![("group:u:p:".to_string(), "Kino".to_string(), 5)]
        );

        let failing = RecordingGraphiti::failing("Graphiti unavailable");
        let deps = RetrievalDeps {
            executor: &executor,
            embedder: &embedder,
            timeline: &EmptyEventTimeline,
            graphiti: &failing,
        };
        let failed = drive_sync(retrieve_context(&config, &deps, &input())).expect("bridge");
        assert_eq!(failed.source, RetrievalSource::None);
        assert_eq!(failed.graphiti, Some(Vec::new()));
    }

    /// The `it.each` table of `tests/unit/world-model/retrieval.test.ts:188-198`.
    #[test]
    fn the_intent_status_filters_match_the_source() {
        let filter = |text: &str| {
            status_filter_for_intent(
                plan_query(&QueryPlanInput {
                    text: text.to_string(),
                    now: None,
                })
                .intent,
            )
        };
        assert_eq!(
            filter("Was habe ich mit Kino gemacht?"),
            Some(vec!["completed".to_string(), "attended".to_string()])
        );
        assert_eq!(
            filter("Was ist mit Kino geplant?"),
            Some(vec![
                "planned".to_string(),
                "proposed".to_string(),
                "in_progress".to_string()
            ])
        );
        assert_eq!(
            filter("Was ist mit Kino abgesagt?"),
            Some(vec!["cancelled".to_string(), "no_show".to_string()])
        );
        assert_eq!(
            filter("Was steht noch offen?"),
            Some(vec![
                "planned".to_string(),
                "proposed".to_string(),
                "in_progress".to_string()
            ])
        );
        assert_eq!(filter("Kino"), None);
    }

    fn timeline_point(to_status: EventStatus, reason: Option<&str>) -> EventTimelinePoint {
        EventTimelinePoint {
            id: "transition".to_string(),
            event_id: "event-1".to_string(),
            from_status: None,
            to_status,
            reason: reason.map(str::to_string),
            source_observation_id: None,
            confidence: None,
            transitioned_at: "2025-01-01T10:00:00Z".to_string(),
            title: "Kino".to_string(),
        }
    }

    fn sample_result() -> RetrievalContextResult {
        RetrievalContextResult {
            source: RetrievalSource::Structured,
            enabled: true,
            structured: vec![StructuredEventHit {
                id: "event-1".to_string(),
                title: "Kino".to_string(),
                status: EventStatus::Completed,
                scheduled_for: Some("2025-01-01T18:00:00Z".to_string()),
                ends_at: Some("2025-01-01T20:00:00Z".to_string()),
                timeline: vec![
                    timeline_point(EventStatus::Planned, Some("gebucht")),
                    timeline_point(EventStatus::Completed, None),
                ],
            }],
            full_text: vec![FullTextHit {
                id: "same-assertion".to_string(),
                predicate: "mag".to_string(),
                object_value: "Kino".to_string(),
                modality: Modality::Reported,
                status: "active".to_string(),
                confidence: 0.9,
                source_observation_id: Some("obs-1".to_string()),
                known_from: "2025-01-01T00:00:00.000Z".to_string(),
            }],
            assertions: Some(vec![
                AssertionRetrievalHit {
                    id: "same-assertion".to_string(),
                    subject_name: "Mira".to_string(),
                    predicate: "mag".to_string(),
                    object_value: Some("Kino".to_string()),
                    modality: "reported".to_string(),
                    status: "active".to_string(),
                    confidence: 0.9,
                    known_from: Some("2025-01-01".to_string()),
                    known_to: None,
                    valid_from: None,
                    source_observation_id: Some("obs-1".to_string()),
                },
                AssertionRetrievalHit {
                    id: "assertion-2".to_string(),
                    subject_name: "Mira".to_string(),
                    predicate: "meidet".to_string(),
                    object_value: Some("Horror".to_string()),
                    modality: "reported".to_string(),
                    status: "active".to_string(),
                    confidence: 0.8,
                    known_from: Some("2025-01-01".to_string()),
                    known_to: None,
                    valid_from: None,
                    source_observation_id: Some("obs-2".to_string()),
                },
            ]),
            tasks: Some(vec![
                TaskRetrievalHit {
                    id: "task-1".to_string(),
                    title: "Tickets".to_string(),
                    status: "open".to_string(),
                    due_at: Some("2025-02-01".to_string()),
                    created_at: "2025-01-01".to_string(),
                },
                TaskRetrievalHit {
                    id: "task-2".to_string(),
                    title: "Snacks".to_string(),
                    status: "open".to_string(),
                    due_at: None,
                    created_at: "2025-01-01".to_string(),
                },
            ]),
            relations: None,
            open_loops: None,
            vector: Vec::new(),
            graphiti: None,
        }
    }

    /// `tests/unit/world-model/retrieval.test.ts:334-463` — every source, the
    /// optional fields and the canonical de-duplication.
    #[test]
    fn the_formatter_covers_every_source_and_deduplicates() {
        let mut result = sample_result();
        result.relations = Some(vec![RelationRetrievalHit {
            id: "relation-1".to_string(),
            source_entity_name: "Mira".to_string(),
            target_entity_name: "Noah".to_string(),
            relation_type: "knows".to_string(),
            confidence: 0.7,
            valid_from: None,
        }]);
        result.open_loops = Some(vec![
            OpenLoopRetrievalHit {
                id: "loop-1".to_string(),
                loop_type: "clarification".to_string(),
                status: "open".to_string(),
                question: Some("Welcher Film?".to_string()),
                attempts: 1.0,
                last_asked_at: None,
            },
            OpenLoopRetrievalHit {
                id: "loop-2".to_string(),
                loop_type: "follow_up".to_string(),
                status: "open".to_string(),
                question: None,
                attempts: 0.0,
                last_asked_at: None,
            },
        ]);
        result.vector = vec![VectorHit {
            target_type: "event".to_string(),
            target_id: "event-2".to_string(),
            text: "Filmabend".to_string(),
            similarity: 0.82,
            model: "test".to_string(),
            model_version: "1".to_string(),
        }];
        result.graphiti = Some(vec![
            GraphitiFact {
                uuid: Some("graph-1".to_string()),
                fact: "Mira geht ins Kino".to_string(),
                ..GraphitiFact::default()
            },
            GraphitiFact {
                uuid: None,
                fact: "Kino am Freitag".to_string(),
                ..GraphitiFact::default()
            },
        ]);

        let formatted = format_world_model_context(&result).expect("a context");
        assert!(formatted.contains("- Event: Kino; status=completed; time=2025-01-01T18:00:00Z - 2025-01-01T20:00:00Z; history=planned (gebucht) -> completed"));
        assert!(formatted.contains("- Assertion [same-assertion]: mag = Kino; modality=reported; status=active; confidence=0.9; source=obs-1"));
        assert!(formatted.contains("Mira meidet = Horror"));
        assert_eq!(
            formatted.matches("Assertion [same-assertion]").count(),
            1,
            "the full-text line wins over the typed assertion line"
        );
        assert!(formatted.contains("- Task: Tickets; status=open; due=2025-02-01"));
        assert!(formatted.contains("- Task: Snacks; status=open\n"));
        assert!(formatted.contains("- Relation [relation-1]: Mira knows Noah; confidence=0.7"));
        assert!(formatted.contains("question=Welcher Film?"));
        assert!(formatted.contains("- Open loop [loop-2]: follow_up; status=open; question=\n"));
        assert!(formatted.contains("- Semantic evidence [event-2]: Filmabend; similarity=0.82"));
        assert!(formatted.contains("- Graphiti derived fact: Kino am Freitag"));
        assert!(formatted.contains("- Graphiti derived fact: Mira geht ins Kino"));
    }

    /// `tests/unit/world-model/retrieval.test.ts:465-475`.
    #[test]
    fn an_empty_result_formats_to_none() {
        assert_eq!(
            format_world_model_context(&RetrievalContextResult {
                structured: Vec::new(),
                full_text: Vec::new(),
                vector: Vec::new(),
                source: RetrievalSource::None,
                enabled: true,
                assertions: None,
                tasks: None,
                relations: None,
                open_loops: None,
                graphiti: None,
            }),
            None
        );
    }

    /// `String(number)` for the reachable range — `0.9` stays `0.9` and `1`
    /// has no `.0`.
    #[test]
    fn numbers_are_rendered_like_javascript() {
        assert_eq!(js_number_string(0.9), "0.9");
        assert_eq!(js_number_string(1.0), "1");
        assert_eq!(js_number_string(0.0), "0");
        assert_eq!(js_number_string(-0.0), "0");
        assert_eq!(js_number_string(1.0 / 3.0), "0.3333333333333333");
        assert_eq!(js_number_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_string(f64::NAN), "NaN");
        assert_eq!(js_number_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_string(f64::NEG_INFINITY), "-Infinity");
    }
}
