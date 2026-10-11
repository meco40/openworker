//! Port of `src/server/world-model/retrieval/structured.ts` (114 lines).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `structured.ts:6-13` (`StructuredEventHit`) | [`StructuredEventHit`] |
//! | `structured.ts:15-21` (`EventRow`) | the row reads of [`find_structured_events`] |
//! | `structured.ts:23-33` (`FindStructuredEventsOptions`) | [`FindStructuredEventsOptions`] |
//! | `structured.ts:40-122` (`findStructuredEvents`) | [`find_structured_events`] |
//! | `structured.ts:102-106` (statement) | [`statement_sql`] |
//! | `repositories/eventRepository.ts:179-195` (`listEventTimeline`) | [`EventTimelineLoader`], [`EventTimelinePoint`] |
//!
//! # The dependency on `repositories/eventRepository.ts`
//!
//! `listEventTimeline(row.id, db)` (`structured.ts:112`) lives in the
//! repositories package of this slice (P1). So that this module compiles and is
//! testable on its own — and because the projector calls `findStructuredEvents`
//! positionally (`projector/projectWindow.ts:389-396`) — that call is an
//! [`EventTimelineLoader`] seam, exactly like
//! [`crate::world_model::db::PgExecutor`]: the port takes the executor as a
//! parameter and the repositories package supplies the one productive
//! implementation. [`EventTimelinePoint`] is the reduced port of the shape the
//! loader returns; the parent reconciles the two after the parallel packages
//! land (OP).
//!
//! # The two call shapes of `findStructuredEvents`
//!
//! TypeScript overloads one function: an options object, or the positional
//! `(userId, personaId, workspaceId, term, limit, db)` form. The positional form
//! **ignores** `timeWindow` and `statusFilter` — it never reads them
//! (`structured.ts:54-63`) — and takes the sixth argument as the executor. The
//! port has one shape: [`FindStructuredEventsOptions`] without
//! `time_window`/`status_filter` *is* the positional call.
//!
//! # Verified TypeScript quirks
//!
//! * A whitespace-only `term` answers `[]` before any statement (`:66-67`).
//! * There is **no** limit clamp here (unlike the domain modules): the limit is
//!   `opts.limit ?? 5` as it arrives (`:99`), and `index.ts:103` is what clamps
//!   it to 1..50.
//! * `timeWindow.after` binds the same value twice
//!   (`scheduled_for >= $n OR ends_at >= $m`, `:79`) while `timeWindow.before`
//!   binds once and allows a `NULL` schedule (`:83`).
//! * `status = ANY($n)` is emitted only for a **non-empty** filter (`:86`).
//! * The timeline is loaded **sequentially in row order** (`:111-112`); the port
//!   awaits each row in order instead of joining them.
//! * `row.scheduled_for ?? undefined` and `row.ends_at ?? undefined`
//!   (`:117-118`) fold `NULL` into an absent field.
//! * `statusFilterForIntent` of `index.ts:51-64` yields `'attended'`, which the
//!   `EventStatus` union (`types.ts:10-17`) does **not** contain, so the port
//!   keeps the filter as text instead of an enum (see
//!   [`FindStructuredEventsOptions::status_filter`]).
//! * `row.status` is parsed into [`EventStatus`]; the column is the enum
//!   `world_model_event_status` (`migrations/001_world_model.sql:21-24`), so a
//!   value outside the union cannot occur. An unparsable value maps to
//!   `EventStatus::Unknown` — the member the union already has for the literal
//!   `'unknown'` — instead of failing (OP).

use serde_json::Value;

use crate::world_model::db::{
    scoped_query, BoxFuture, NormalizedScope, PgError, PgExecutor, PgRow, PgStatement, PgValue,
};
use crate::world_model::types::EventStatus;

use super::query_planner::TimeWindow;
use super::{row_optional_string, row_string};

/// `EventTimelinePoint extends EventTransition` —
/// `repositories/eventRepository.ts:179-181`.
///
/// The transition columns of `types.ts:108-111` plus the joined `title`.
#[derive(Debug, Clone, PartialEq)]
pub struct EventTimelinePoint {
    pub id: String,
    pub event_id: String,
    pub from_status: Option<EventStatus>,
    pub to_status: EventStatus,
    pub reason: Option<String>,
    pub source_observation_id: Option<String>,
    pub confidence: Option<f64>,
    pub transitioned_at: String,
    pub title: String,
}

/// `StructuredEventHit` from `structured.ts:6-13`.
#[derive(Debug, Clone, PartialEq)]
pub struct StructuredEventHit {
    pub id: String,
    pub title: String,
    pub status: EventStatus,
    /// `row.scheduled_for ?? undefined`.
    pub scheduled_for: Option<String>,
    /// `row.ends_at ?? undefined`.
    pub ends_at: Option<String>,
    /// `Awaited<ReturnType<typeof listEventTimeline>>` — `:12`.
    pub timeline: Vec<EventTimelinePoint>,
}

/// `FindStructuredEventsOptions` from `structured.ts:23-33`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FindStructuredEventsOptions {
    pub term: String,
    /// `opts.limit ?? 5` — unclamped (`:99`).
    pub limit: Option<i64>,
    pub time_window: Option<TimeWindow>,
    /// `EventStatus[]` in the source type, but the caller
    /// (`index.ts:116-118`) casts the `'attended'` literal into it, which the
    /// union does not contain; the port passes the literals as text.
    pub status_filter: Option<Vec<String>>,
    pub valid_as_of: Option<String>,
    pub known_as_of: Option<String>,
}

/// `listEventTimeline(eventId, db)` — `repositories/eventRepository.ts:183-195`.
///
/// The repositories package implements this; tests use a recording double. The
/// scope travels with the call because the implementation's statement runs in
/// its own scoped transaction, like every other statement of the slice.
pub trait EventTimelineLoader: Send + Sync {
    fn timeline<'a>(
        &'a self,
        executor: &'a dyn PgExecutor,
        scope: &'a NormalizedScope,
        event_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<EventTimelinePoint>, PgError>>;
}

/// A loader without history — the `[]` of a caller without a repositories
/// package. Rust-only (like `db::UnconfiguredPgExecutor`); the retrieval path
/// uses the real loader.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmptyEventTimeline;

impl EventTimelineLoader for EmptyEventTimeline {
    fn timeline<'a>(
        &'a self,
        _executor: &'a dyn PgExecutor,
        _scope: &'a NormalizedScope,
        _event_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<EventTimelinePoint>, PgError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// The truthiness of an optional string — `if (value)`.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// `row.status` as the [`EventStatus`] union of `types.ts:10-17`.
fn event_status(row: &PgRow) -> EventStatus {
    match row.get("status") {
        Some(Value::String(text)) => {
            serde_json::from_value::<EventStatus>(Value::String(text.clone()))
                .unwrap_or(EventStatus::Unknown)
        }
        _ => EventStatus::Unknown,
    }
}

/// The `WHERE` clause, the `LIMIT` placeholder and the parameters of
/// `structured.ts:69-99`.
fn build(
    scope: &NormalizedScope,
    options: &FindStructuredEventsOptions,
) -> (String, String, Vec<PgValue>) {
    let mut conditions = vec![
        "user_id = $1".to_string(),
        "persona_id = $2".to_string(),
        "workspace_id = $3".to_string(),
        "title ILIKE ('%' || $4 || '%')".to_string(),
    ];
    let mut params = vec![
        PgValue::text(scope.user_id.as_str()),
        PgValue::text(scope.persona_id.as_str()),
        PgValue::text(scope.workspace_id.as_str()),
        PgValue::text(options.term.trim()),
    ];
    let mut index = 5;

    let window = options.time_window.as_ref();
    if let Some(after) = window.and_then(|window| present(window.after.as_deref())) {
        // Two placeholders, one value (`structured.ts:79-80`).
        conditions.push(format!(
            "(scheduled_for >= ${index} OR ends_at >= ${})",
            index + 1
        ));
        params.push(PgValue::text(after));
        params.push(PgValue::text(after));
        index += 2;
    }
    if let Some(before) = window.and_then(|window| present(window.before.as_deref())) {
        conditions.push(format!(
            "(scheduled_for <= ${index} OR scheduled_for IS NULL)"
        ));
        params.push(PgValue::text(before));
        index += 1;
    }
    if let Some(filter) = options
        .status_filter
        .as_ref()
        .filter(|values| !values.is_empty())
    {
        conditions.push(format!("status = ANY(${index})"));
        params.push(PgValue::text_array(filter.clone()));
        index += 1;
    }
    if let Some(valid_as_of) = present(options.valid_as_of.as_deref()) {
        conditions.push(format!(
            "(scheduled_for IS NULL OR scheduled_for <= ${index})"
        ));
        params.push(PgValue::text(valid_as_of));
        index += 1;
    }
    if let Some(known_as_of) = present(options.known_as_of.as_deref()) {
        conditions.push(format!("created_at <= ${index}"));
        params.push(PgValue::text(known_as_of));
        index += 1;
    }

    // `params.push(opts.limit ?? 5)` — no clamp, and the placeholder is the
    // *current* index, which the row limit then consumes.
    params.push(PgValue::int(options.limit.unwrap_or(5)));
    (conditions.join(" AND "), format!("${index}"), params)
}

/// The statement of `structured.ts:102-106`, token for token.
fn statement_sql(conditions: &str, limit_param: &str) -> String {
    format!("SELECT id, title, status, scheduled_for, ends_at\n     FROM world_model_events\n     WHERE {conditions}\n     ORDER BY updated_at DESC\n     LIMIT {limit_param}")
}

/// `findStructuredEvents(...)` — `structured.ts:40-122`.
///
/// The term is trimmed first; an empty term answers `[]` without a statement
/// (`:66-67`). The timeline of every hit is loaded in row order through
/// `loader`.
pub async fn find_structured_events(
    executor: &dyn PgExecutor,
    loader: &dyn EventTimelineLoader,
    scope: &NormalizedScope,
    options: &FindStructuredEventsOptions,
) -> Result<Vec<StructuredEventHit>, PgError> {
    let trimmed = options.term.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let (conditions, limit_param, params) = build(scope, options);
    let statement = PgStatement::with_params(statement_sql(&conditions, &limit_param), params);
    let result = scoped_query::<PgError>(executor, scope, statement).await?;

    let mut hits = Vec::with_capacity(result.rows.len());
    for row in &result.rows {
        let id = row_string(row, "id");
        // `await listEventTimeline(row.id, db)` — sequential, in row order.
        let timeline = loader.timeline(executor, scope, id.as_str()).await?;
        hits.push(StructuredEventHit {
            id,
            title: row_string(row, "title"),
            status: event_status(row),
            scheduled_for: row_optional_string(row, "scheduled_for"),
            ends_at: row_optional_string(row, "ends_at"),
            timeline,
        });
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult};
    use serde_json::json;

    use super::super::test_scope;

    /// A loader double: a scripted history per event id and the call order.
    struct RecordingTimeline {
        points: HashMap<String, Vec<EventTimelinePoint>>,
        calls: Mutex<Vec<String>>,
        failure: Option<PgError>,
    }

    impl RecordingTimeline {
        fn new(points: Vec<(&str, Vec<EventTimelinePoint>)>) -> Self {
            Self {
                points: points
                    .into_iter()
                    .map(|(id, points)| (id.to_string(), points))
                    .collect(),
                calls: Mutex::new(Vec::new()),
                failure: None,
            }
        }

        fn failing(error: PgError) -> Self {
            Self {
                points: HashMap::new(),
                calls: Mutex::new(Vec::new()),
                failure: Some(error),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls mutex").clone()
        }
    }

    impl EventTimelineLoader for RecordingTimeline {
        fn timeline<'a>(
            &'a self,
            _executor: &'a dyn PgExecutor,
            _scope: &'a NormalizedScope,
            event_id: &'a str,
        ) -> BoxFuture<'a, Result<Vec<EventTimelinePoint>, PgError>> {
            self.calls
                .lock()
                .expect("calls mutex")
                .push(event_id.to_string());
            let points = self.points.get(event_id).cloned().unwrap_or_default();
            let failure = self.failure.clone();
            Box::pin(async move {
                if let Some(error) = failure {
                    return Err(error);
                }
                Ok(points)
            })
        }
    }

    fn point(to_status: EventStatus) -> EventTimelinePoint {
        EventTimelinePoint {
            id: "transition-1".to_string(),
            event_id: "event-1".to_string(),
            from_status: None,
            to_status,
            reason: Some("gebucht".to_string()),
            source_observation_id: None,
            confidence: None,
            transitioned_at: "2025-01-01T10:00:00Z".to_string(),
            title: "Kino".to_string(),
        }
    }

    fn event_row(id: &str, status: &str) -> PgRow {
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

    fn statement_of(executor: &RecordingExecutor) -> PgStatement {
        executor
            .calls()
            .into_iter()
            .find_map(|call| match call {
                Recorded::Statement(statement)
                    if !statement.params.is_empty()
                        && statement.sql != crate::world_model::db::SQL_SET_SCOPE =>
                {
                    Some(statement)
                }
                _ => None,
            })
            .expect("one parameterised statement")
    }

    fn options(term: &str) -> FindStructuredEventsOptions {
        FindStructuredEventsOptions {
            term: term.to_string(),
            ..FindStructuredEventsOptions::default()
        }
    }

    fn search_with(
        options: &FindStructuredEventsOptions,
        rows: Vec<PgRow>,
        loader: &RecordingTimeline,
    ) -> (Vec<StructuredEventHit>, PgStatement) {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(rows))]);
        let hits = drive_sync(find_structured_events(
            &executor,
            loader,
            &test_scope(),
            options,
        ))
        .expect("bridge")
        .expect("scoped query");
        let statement = statement_of(&executor);
        (hits, statement)
    }

    #[test]
    fn an_empty_term_answers_empty_without_a_statement() {
        let executor = RecordingExecutor::new(Vec::new());
        let loader = RecordingTimeline::new(Vec::new());
        let hits = drive_sync(find_structured_events(
            &executor,
            &loader,
            &test_scope(),
            &options("   "),
        ))
        .expect("bridge")
        .expect("no statement");
        assert!(hits.is_empty());
        assert!(executor.calls().is_empty());
        assert!(loader.calls().is_empty());
    }

    #[test]
    fn the_default_statement_matches_the_source() {
        let loader = RecordingTimeline::new(Vec::new());
        let (_, statement) = search_with(&options("  Kino "), Vec::new(), &loader);
        assert_eq!(
            statement.sql,
            "SELECT id, title, status, scheduled_for, ends_at\n     FROM world_model_events\n     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND title ILIKE ('%' || $4 || '%')\n     ORDER BY updated_at DESC\n     LIMIT $5"
        );
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("Kino"),
                PgValue::int(5),
            ]
        );
    }

    /// The optional branch order of `structured.ts:78-98` and the two
    /// placeholders of `timeWindow.after`.
    #[test]
    fn the_optional_branches_follow_the_source_order() {
        let loader = RecordingTimeline::new(Vec::new());
        let (_, statement) = search_with(
            &FindStructuredEventsOptions {
                term: "Kino".to_string(),
                limit: Some(5),
                time_window: Some(TimeWindow {
                    after: Some("2026-08-11T12:00:00.000Z".to_string()),
                    before: Some("2026-08-18T12:00:00.000Z".to_string()),
                    label: Some("last_week".to_string()),
                }),
                status_filter: Some(vec!["planned".to_string(), "proposed".to_string()]),
                valid_as_of: Some("2024-02-03T00:00:00.000Z".to_string()),
                known_as_of: Some("2024-01-02T00:00:00.000Z".to_string()),
            },
            Vec::new(),
            &loader,
        );
        assert!(
            statement.sql.contains(
                "AND (scheduled_for >= $5 OR ends_at >= $6) AND (scheduled_for <= $7 OR scheduled_for IS NULL) AND status = ANY($8) AND (scheduled_for IS NULL OR scheduled_for <= $9) AND created_at <= $10\n     ORDER BY"
            ),
            "{}",
            statement.sql
        );
        assert!(statement.sql.ends_with("LIMIT $11"), "{}", statement.sql);
        assert_eq!(
            statement.params,
            vec![
                PgValue::text("u1"),
                PgValue::text("p1"),
                PgValue::text("w1"),
                PgValue::text("Kino"),
                PgValue::text("2026-08-11T12:00:00.000Z"),
                PgValue::text("2026-08-11T12:00:00.000Z"),
                PgValue::text("2026-08-18T12:00:00.000Z"),
                PgValue::text_array(vec!["planned".to_string(), "proposed".to_string()]),
                PgValue::text("2024-02-03T00:00:00.000Z"),
                PgValue::text("2024-01-02T00:00:00.000Z"),
                PgValue::int(5),
            ]
        );
    }

    /// An empty `statusFilter` array binds no parameter (`structured.ts:86`),
    /// and an empty `after`/`before` string is falsy (`:78`, `:82`).
    #[test]
    fn empty_optional_values_are_skipped() {
        let loader = RecordingTimeline::new(Vec::new());
        let (_, statement) = search_with(
            &FindStructuredEventsOptions {
                term: "Kino".to_string(),
                time_window: Some(TimeWindow {
                    after: Some(String::new()),
                    before: Some(String::new()),
                    label: None,
                }),
                status_filter: Some(Vec::new()),
                valid_as_of: Some(String::new()),
                known_as_of: None,
                limit: None,
            },
            Vec::new(),
            &loader,
        );
        assert_eq!(statement.params.len(), 5);
        assert!(statement.sql.ends_with("LIMIT $5"));
        assert!(!statement.sql.contains("ANY"));
        let where_clause = statement.sql.split("WHERE ").nth(1).expect("WHERE clause");
        assert!(!where_clause.contains("scheduled_for"));
    }

    /// The history is fetched per row, sequentially, in row order
    /// (`structured.ts:111-112`).
    #[test]
    fn the_timeline_is_loaded_in_row_order() {
        let loader = RecordingTimeline::new(vec![
            (
                "event-1",
                vec![point(EventStatus::Planned), point(EventStatus::Completed)],
            ),
            ("event-2", vec![point(EventStatus::Cancelled)]),
        ]);
        let (hits, _) = search_with(
            &options("Kino"),
            vec![
                event_row("event-1", "completed"),
                event_row("event-2", "cancelled"),
            ],
            &loader,
        );
        assert_eq!(loader.calls(), vec!["event-1", "event-2"]);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].status, EventStatus::Completed);
        assert_eq!(hits[0].timeline.len(), 2);
        assert_eq!(hits[0].timeline[1].to_status, EventStatus::Completed);
        assert_eq!(hits[1].status, EventStatus::Cancelled);
        assert_eq!(hits[1].timeline.len(), 1);
        assert_eq!(hits[0].scheduled_for, None);
        assert_eq!(hits[0].ends_at, None);
    }

    /// The enum column cannot hold another literal; the fallback keeps the
    /// `unknown` member of the union (`types.ts:10-17`).
    #[test]
    fn an_unparsable_status_maps_to_unknown() {
        let loader = RecordingTimeline::new(Vec::new());
        let (hits, _) = search_with(
            &options("Kino"),
            vec![
                event_row("event-1", "unknown"),
                event_row("event-2", "not_a_status"),
            ],
            &loader,
        );
        assert_eq!(hits[0].status, EventStatus::Unknown);
        assert_eq!(hits[1].status, EventStatus::Unknown);
    }

    #[test]
    fn a_failing_statement_propagates() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("boom"))]);
        let loader = RecordingTimeline::new(Vec::new());
        let error = drive_sync(find_structured_events(
            &executor,
            &loader,
            &test_scope(),
            &options("Kino"),
        ))
        .expect("bridge")
        .expect_err("the statement fails");
        assert_eq!(error, PgError::new("boom"));
        assert!(loader.calls().is_empty(), "no row, no history call");
    }

    #[test]
    fn a_failing_timeline_propagates() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row(
            "event-1", "planned",
        )]))]);
        let loader = RecordingTimeline::failing(PgError::new("history unavailable"));
        let error = drive_sync(find_structured_events(
            &executor,
            &loader,
            &test_scope(),
            &options("Kino"),
        ))
        .expect("bridge")
        .expect_err("the history fails");
        assert_eq!(error, PgError::new("history unavailable"));
    }
}
