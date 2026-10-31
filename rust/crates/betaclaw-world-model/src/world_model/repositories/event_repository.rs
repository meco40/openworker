//! Port of `src/server/world-model/repositories/eventRepository.ts` (195 lines)
//! — the event store and its transition log.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `eventRepository.ts:10-27` (`EventRow`) | the column names of the statements and [`to_event`] |
//! | `eventRepository.ts:29-38` (`TransitionRow`) | the column names and [`to_transition`] |
//! | `eventRepository.ts:40-59` (`toEvent`) | [`to_event`] |
//! | `eventRepository.ts:61-72` (`toTransition`) | [`to_transition`] |
//! | `eventRepository.ts:74-105` (`insertEvent`) | [`insert_event`] |
//! | `eventRepository.ts:107-130` (`getEventById`) | [`get_event_by_id`], [`EventScope`] |
//! | `eventRepository.ts:132-143` (`updateEventStatus`) | [`update_event_status`] |
//! | `eventRepository.ts:145-165` (`insertEventTransition`) | [`insert_event_transition`] |
//! | `eventRepository.ts:167-177` (`listEventTransitions`) | [`list_event_transitions`] |
//! | `eventRepository.ts:179-195` (`listEventTimeline`, `EventTimelinePoint`) | [`list_event_timeline`], [`EventTimelinePoint`] |
//! | `eventRepository.ts:79-87` (insert) | [`SQL_INSERT_EVENT`] |
//! | `eventRepository.ts:123-126` (by id) | [`SQL_EVENT_BY_ID`] |
//! | `eventRepository.ts:139-140` (status) | [`SQL_UPDATE_EVENT_STATUS`] |
//! | `eventRepository.ts:150-153` (transition) | [`SQL_INSERT_TRANSITION`] |
//! | `eventRepository.ts:172-173` (transitions) | [`SQL_LIST_TRANSITIONS`] |
//! | `eventRepository.ts:188-191` (timeline) | [`SQL_EVENT_TIMELINE`] |
//!
//! # Scope
//!
//! `getEventById`'s second parameter (`:109`) is a `WHERE` filter like
//! `ObservationScope` in `observation_repository.rs`; the RLS scope is the
//! ambient one, so [`get_event_by_id`] takes both (`filter` and `scope`).
//!
//! # `new Date().toISOString()`
//!
//! `insertEventTransition` falls back to the current instant when
//! `input.transitionedAt` is absent (`:161`). The optional input property already
//! pins the value for a caller that sets it, so the port needs no extra
//! parameter: `input.transitioned_at` is used when present and [`now_iso`]
//! otherwise.
//!
//! # Deviations
//!
//! 1. **`status` is parsed back into the union.** `toEvent` and `toTransition`
//!    forward `row.status`/`row.to_status` (`:52`, `:66`); an out-of-union
//!    literal becomes [`EventStatus::Unknown`], the union's own catch-all, and an
//!    out-of-union `from_status` becomes `None` like the `?? undefined` of `:65`.

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_number, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{
    EventInput, EventRecord, EventStatus, EventTransition, EventTransitionInput,
};

/// `Pick<EventInput, 'userId' | 'personaId' | 'workspaceId'>` of
/// `eventRepository.ts:109`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventScope {
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — `undefined` means "do not filter on it".
    pub workspace_id: Option<String>,
}

/// `EventTimelinePoint extends EventTransition` from `eventRepository.ts:179-181`.
#[derive(Debug, Clone, PartialEq)]
pub struct EventTimelinePoint {
    pub transition: EventTransition,
    /// `e.title` of the join (`:189`).
    pub title: String,
}

/// `eventRepository.ts:79-87`.
pub const SQL_INSERT_EVENT: &str = "INSERT INTO world_model_events\n  (user_id, persona_id, workspace_id, title, event_type, subject_entity_id,\n   counterpart_entity_id, scheduled_for, ends_at, status, observed_at, idempotency_key, replaces_event_id)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\nON CONFLICT (user_id, persona_id, workspace_id, idempotency_key)\n  WHERE idempotency_key IS NOT NULL DO UPDATE SET updated_at = world_model_events.updated_at\nRETURNING id, user_id, persona_id, workspace_id, title, event_type, subject_entity_id,\n          counterpart_entity_id, scheduled_for, ends_at, status, observed_at,\n          created_at, updated_at, idempotency_key, replaces_event_id";

/// The `SELECT` prefix of `eventRepository.ts:123-126`; the `WHERE` clause is
/// appended because the source joins the conditions at run time.
pub const SQL_EVENT_BY_ID: &str = "SELECT id, user_id, persona_id, workspace_id, title, event_type, subject_entity_id,\n        counterpart_entity_id, scheduled_for, ends_at, status, observed_at, created_at, updated_at,\n        idempotency_key, replaces_event_id\n  FROM world_model_events WHERE ";

/// `eventRepository.ts:139-140`.
pub const SQL_UPDATE_EVENT_STATUS: &str = "UPDATE world_model_events SET status = $2, observed_at = COALESCE($3, observed_at), updated_at = now()\nWHERE id = $1";

/// `eventRepository.ts:150-153`.
pub const SQL_INSERT_TRANSITION: &str = "INSERT INTO world_model_event_transitions\n  (event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at)\nVALUES ($1,$2,$3,$4,$5,$6,$7)\nRETURNING id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at";

/// `eventRepository.ts:172-173`.
pub const SQL_LIST_TRANSITIONS: &str = "SELECT id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at\nFROM world_model_event_transitions WHERE event_id = $1 ORDER BY transitioned_at ASC";

/// `eventRepository.ts:188-191`.
pub const SQL_EVENT_TIMELINE: &str = "SELECT t.id, t.event_id, t.from_status, t.to_status, t.reason, t.source_observation_id,\n       t.confidence, t.transitioned_at, e.title\nFROM world_model_event_transitions t JOIN world_model_events e ON e.id = t.event_id\nWHERE t.event_id = $1 ORDER BY t.transitioned_at ASC";

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `toEvent(row)` — `eventRepository.ts:40-59`.
fn to_event(row: &PgRow) -> EventRecord {
    let replaces_event_id = row_optional_text(row, "replaces_event_id");
    EventRecord {
        input: EventInput {
            user_id: row_text(row, "user_id"),
            persona_id: row_text(row, "persona_id"),
            workspace_id: Some(row_text(row, "workspace_id")),
            title: row_text(row, "title"),
            event_type: row_text(row, "event_type"),
            subject_entity_id: row_optional_text(row, "subject_entity_id"),
            counterpart_entity_id: row_optional_text(row, "counterpart_entity_id"),
            scheduled_for: row_optional_text(row, "scheduled_for"),
            ends_at: row_optional_text(row, "ends_at"),
            status: Some(status_from_column(&row_text(row, "status"))),
            observed_at: row_optional_text(row, "observed_at"),
            idempotency_key: row_optional_text(row, "idempotency_key"),
            replaces_event_id: replaces_event_id.clone(),
        },
        id: row_text(row, "id"),
        status: status_from_column(&row_text(row, "status")),
        created_at: row_text(row, "created_at"),
        updated_at: row_text(row, "updated_at"),
        replaces_event_id,
    }
}

/// `toTransition(row)` — `eventRepository.ts:61-72`.
fn to_transition(row: &PgRow) -> EventTransition {
    EventTransition {
        input: EventTransitionInput {
            event_id: row_text(row, "event_id"),
            to_status: status_from_column(&row_text(row, "to_status")),
            from_status: optional_status_from_column(row),
            reason: row_optional_text(row, "reason"),
            source_observation_id: row_optional_text(row, "source_observation_id"),
            confidence: Some(row_number(row, "confidence")),
            transitioned_at: row_optional_text(row, "transitioned_at"),
        },
        id: row_text(row, "id"),
        transitioned_at: row_text(row, "transitioned_at"),
    }
}

/// `row.from_status ?? undefined` (`:65`) — deviation 1.
fn optional_status_from_column(row: &PgRow) -> Option<EventStatus> {
    match row.get("from_status") {
        Some(serde_json::Value::String(text)) => Some(status_from_column(text)),
        _ => None,
    }
}

/// The literal of the `EventStatus` union (`types.ts:10-17`).
fn status_literal(status: EventStatus) -> &'static str {
    match status {
        EventStatus::Proposed => "proposed",
        EventStatus::Planned => "planned",
        EventStatus::InProgress => "in_progress",
        EventStatus::Completed => "completed",
        EventStatus::Cancelled => "cancelled",
        EventStatus::NoShow => "no_show",
        EventStatus::Unknown => "unknown",
    }
}

/// The `status` column of a row; `unknown` is the union's own catch-all, so an
/// out-of-union literal lands there (deviation 1).
fn status_from_column(text: &str) -> EventStatus {
    match text {
        "proposed" => EventStatus::Proposed,
        "planned" => EventStatus::Planned,
        "in_progress" => EventStatus::InProgress,
        "completed" => EventStatus::Completed,
        "cancelled" => EventStatus::Cancelled,
        "no_show" => EventStatus::NoShow,
        _ => EventStatus::Unknown,
    }
}

/// `insertEvent(input, db)` — `eventRepository.ts:74-105`.
///
/// The conflict target is the idempotency key inside the tenant scope and the
/// `DO UPDATE` writes `updated_at` back to itself, so the insert is a no-op that
/// still returns the stored row.
pub async fn insert_event<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &EventInput,
) -> Result<EventRecord, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_EVENT,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.clone().unwrap_or_default()),
                PgValue::text(input.title.as_str()),
                PgValue::text(input.event_type.as_str()),
                PgValue::nullable_text(input.subject_entity_id.clone()),
                PgValue::nullable_text(input.counterpart_entity_id.clone()),
                PgValue::nullable_text(input.scheduled_for.clone()),
                PgValue::nullable_text(input.ends_at.clone()),
                PgValue::text(status_literal(input.status.unwrap_or(EventStatus::Planned))),
                PgValue::nullable_text(input.observed_at.clone()),
                PgValue::nullable_text(input.idempotency_key.clone()),
                PgValue::nullable_text(input.replaces_event_id.clone()),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_event(row)),
        None => Err(E::from(PgError::new(MISSING_EVENT_ROW))),
    }
}
/// The port's answer for a missing `RETURNING` row (`:104`).
pub const MISSING_EVENT_ROW: &str = "[world-model] event insert returned no row";

/// `getEventById(id, scope?, db)` — `eventRepository.ts:107-130`.
///
/// `filter` is the source's `scope?: Pick<EventInput, …>`, `scope` is the ambient
/// RLS scope (see the module header).
pub async fn get_event_by_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    filter: Option<&EventScope>,
) -> Result<Option<EventRecord>, E> {
    let conditions = event_conditions(id, filter);
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            format!("{SQL_EVENT_BY_ID}{}", conditions.clause),
            conditions.params,
        ),
    )
    .await?;
    Ok(result.first().map(to_event))
}

/// The `conditions`/`values` pair of `eventRepository.ts:112-121`.
struct Conditions {
    clause: String,
    params: Vec<PgValue>,
}

/// `conditions`/`values` of `getEventById` — `eventRepository.ts:112-121`.
fn event_conditions(id: &str, filter: Option<&EventScope>) -> Conditions {
    let mut conditions = vec!["id = $1".to_string()];
    let mut params = vec![PgValue::text(id)];
    if let Some(filter) = filter {
        params.push(PgValue::text(filter.user_id.as_str()));
        params.push(PgValue::text(filter.persona_id.as_str()));
        conditions.push(format!("user_id = ${}", params.len() - 1));
        conditions.push(format!("persona_id = ${}", params.len()));
        if let Some(workspace_id) = filter.workspace_id.as_deref() {
            params.push(PgValue::text(workspace_id));
            conditions.push(format!("workspace_id = ${}", params.len()));
        }
    }
    Conditions {
        clause: conditions.join(" AND "),
        params,
    }
}

/// `updateEventStatus(id, status, observedAt?, db)` —
/// `eventRepository.ts:132-143`.
pub async fn update_event_status<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    status: EventStatus,
    observed_at: Option<&str>,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_UPDATE_EVENT_STATUS,
            vec![
                PgValue::text(id),
                PgValue::text(status_literal(status)),
                PgValue::nullable_text(observed_at.map(str::to_string)),
            ],
        ),
    )
    .await
    .map(|_| ())
}

/// `insertEventTransition(input, db)` — `eventRepository.ts:145-165`.
pub async fn insert_event_transition<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &EventTransitionInput,
) -> Result<EventTransition, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_TRANSITION,
            vec![
                PgValue::text(input.event_id.as_str()),
                PgValue::nullable_text(
                    input
                        .from_status
                        .map(|status| status_literal(status).to_string()),
                ),
                PgValue::text(status_literal(input.to_status)),
                PgValue::nullable_text(input.reason.clone()),
                PgValue::nullable_text(input.source_observation_id.clone()),
                PgValue::Float64(input.confidence.unwrap_or(0.8)),
                PgValue::text(input.transitioned_at.clone().unwrap_or_else(now_iso)),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_transition(row)),
        None => Err(E::from(PgError::new(MISSING_TRANSITION_ROW))),
    }
}

/// The port's answer for a missing `RETURNING` row (`:164`).
pub const MISSING_TRANSITION_ROW: &str = "[world-model] event transition insert returned no row";

/// `listEventTransitions(eventId, db)` — `eventRepository.ts:167-177`.
pub async fn list_event_transitions<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event_id: &str,
) -> Result<Vec<EventTransition>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_LIST_TRANSITIONS, vec![PgValue::text(event_id)]),
    )
    .await?;
    Ok(result.rows.iter().map(to_transition).collect())
}

/// `listEventTimeline(eventId, db)` — `eventRepository.ts:183-195`.
///
/// `{ ...toTransition(row), title: row.title }` of `:194`.
pub async fn list_event_timeline<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event_id: &str,
) -> Result<Vec<EventTimelinePoint>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_EVENT_TIMELINE, vec![PgValue::text(event_id)]),
    )
    .await?;
    Ok(result
        .rows
        .iter()
        .map(|row| EventTimelinePoint {
            transition: to_transition(row),
            title: row_text(row, "title"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn event_input() -> EventInput {
        EventInput {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: None,
            title: "Kickoff".to_string(),
            event_type: "meeting".to_string(),
            subject_entity_id: None,
            counterpart_entity_id: None,
            scheduled_for: Some("2026-10-11T09:00:00.000Z".to_string()),
            ends_at: None,
            status: None,
            observed_at: None,
            idempotency_key: None,
            replaces_event_id: None,
        }
    }

    fn event_row() -> PgRow {
        json!({
            "id": "ev1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "",
            "title": "Kickoff",
            "event_type": "meeting",
            "subject_entity_id": null,
            "counterpart_entity_id": null,
            "scheduled_for": "2026-10-11T09:00:00.000Z",
            "ends_at": null,
            "status": "planned",
            "observed_at": null,
            "created_at": "2026-10-10T10:00:00.000Z",
            "updated_at": "2026-10-10T10:00:00.000Z",
            "idempotency_key": null,
            "replaces_event_id": null,
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn transition_row() -> PgRow {
        json!({
            "id": "t1",
            "event_id": "ev1",
            "from_status": "planned",
            "to_status": "completed",
            "reason": "done",
            "source_observation_id": null,
            "confidence": 0.8,
            "transitioned_at": "2026-10-10T11:00:00.000Z",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    #[test]
    fn an_insert_runs_scoped_and_binds_the_event_columns() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row()]))]);
        let event = drive_sync(insert_event::<PgError>(
            &executor,
            Some(&scope()),
            &event_input(),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(event.id, "ev1");
        assert_eq!(event.status, EventStatus::Planned);
        assert_eq!(event.input.status, Some(EventStatus::Planned));
        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_EVENT.to_string(),
                SQL_COMMIT.to_string(),
                "<release>".to_string(),
            ]
        );
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("Kickoff"),
                    PgValue::text("meeting"),
                    PgValue::Null,
                    PgValue::Null,
                    PgValue::text("2026-10-11T09:00:00.000Z"),
                    PgValue::Null,
                    PgValue::text("planned"),
                    PgValue::Null,
                    PgValue::Null,
                    PgValue::Null,
                ],
                "`workspaceId ?? ''`, `status ?? 'planned'`, the rest `?? null`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn the_status_update_binds_the_coalesced_timestamp() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(1))]);
        drive_sync(update_event_status::<PgError>(
            &executor,
            None,
            "ev1",
            EventStatus::NoShow,
            None,
        ))
        .expect("bridge")
        .expect("update");
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_UPDATE_EVENT_STATUS);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("ev1"),
                        PgValue::text("no_show"),
                        PgValue::Null,
                    ],
                    "`observedAt ?? null` keeps the stored value through `COALESCE`"
                );
            }
            other => panic!("expected the status update, got {other:?}"),
        }
    }

    #[test]
    fn a_transition_binds_the_caller_stamp_and_defaults_the_confidence() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![transition_row()]))]);
        let input = EventTransitionInput {
            event_id: "ev1".to_string(),
            to_status: EventStatus::Completed,
            from_status: Some(EventStatus::Planned),
            reason: Some("done".to_string()),
            source_observation_id: None,
            confidence: None,
            transitioned_at: Some("2026-10-10T11:00:00.000Z".to_string()),
        };
        let transition = drive_sync(insert_event_transition::<PgError>(
            &executor,
            Some(&scope()),
            &input,
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(transition.id, "t1");
        assert_eq!(transition.input.to_status, EventStatus::Completed);
        assert_eq!(transition.input.from_status, Some(EventStatus::Planned));
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("ev1"),
                    PgValue::text("planned"),
                    PgValue::text("completed"),
                    PgValue::text("done"),
                    PgValue::Null,
                    PgValue::Float64(0.8),
                    PgValue::text("2026-10-10T11:00:00.000Z"),
                ],
                "`fromStatus ?? null`, `confidence ?? 0.8`, `transitionedAt ?? now`"
            ),
            other => panic!("expected the transition, got {other:?}"),
        }

        let generated =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![transition_row()]))]);
        let mut without_stamp = input.clone();
        without_stamp.transitioned_at = None;
        without_stamp.from_status = None;
        let started_at = chrono::Utc::now().timestamp_millis();
        drive_sync(insert_event_transition::<PgError>(
            &generated,
            None,
            &without_stamp,
        ))
        .expect("bridge")
        .expect("insert");
        match &generated.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params[1], PgValue::Null);
                match &statement.params[6] {
                    PgValue::Text(stamp) => {
                        let parsed = chrono::DateTime::parse_from_rfc3339(stamp)
                            .expect("generated ISO timestamp");
                        assert!((0..=1_000).contains(&(parsed.timestamp_millis() - started_at)));
                        assert!(stamp.ends_with('Z'));
                        let millis = stamp
                            .rsplit_once('.')
                            .expect("fractional seconds")
                            .1
                            .strip_suffix('Z')
                            .expect("UTC suffix");
                        assert_eq!(millis.len(), 3, "ISO timestamp keeps millisecond precision");
                    }
                    other => panic!("expected the generated stamp, got {other:?}"),
                }
            }
            other => panic!("expected the transition, got {other:?}"),
        }
    }

    #[test]
    fn the_lists_read_the_transition_log_and_the_timeline() {
        let transitions =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![transition_row()]))]);
        let rows = drive_sync(list_event_transitions::<PgError>(&transitions, None, "ev1"))
            .expect("bridge")
            .expect("list");
        assert_eq!(rows.len(), 1);
        match &transitions.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_LIST_TRANSITIONS);
                assert_eq!(statement.params, vec![PgValue::text("ev1")]);
            }
            other => panic!("expected the transition list, got {other:?}"),
        }

        let mut joined = transition_row();
        joined.insert("title".to_string(), json!("Kickoff"));
        let timeline = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![joined]))]);
        let points = drive_sync(list_event_timeline::<PgError>(
            &timeline,
            Some(&scope()),
            "ev1",
        ))
        .expect("bridge")
        .expect("timeline");
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].title, "Kickoff");
        assert_eq!(points[0].transition.id, "t1");
        match &timeline.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_EVENT_TIMELINE);
                assert_eq!(statement.params, vec![PgValue::text("ev1")]);
            }
            other => panic!("expected the timeline, got {other:?}"),
        }
    }

    #[test]
    fn the_lookup_appends_the_filter_conditions() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row()]))]);
        let found = drive_sync(get_event_by_id::<PgError>(
            &executor,
            None,
            "ev1",
            Some(&EventScope {
                user_id: "u1".to_string(),
                persona_id: "p1".to_string(),
                workspace_id: Some(String::new()),
            }),
        ))
        .expect("bridge")
        .expect("lookup");
        assert_eq!(found.map(|event| event.id), Some("ev1".to_string()));
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(
                    statement.sql,
                    format!(
                        "{SQL_EVENT_BY_ID}id = $1 AND user_id = $2 AND persona_id = $3 \
                         AND workspace_id = $4"
                    )
                );
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("ev1"),
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text(""),
                    ]
                );
            }
            other => panic!("expected the lookup, got {other:?}"),
        }

        let without = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let found = drive_sync(get_event_by_id::<PgError>(&without, None, "ev1", None))
            .expect("bridge")
            .expect("lookup");
        assert!(found.is_none());
        match &without.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, format!("{SQL_EVENT_BY_ID}id = $1"));
            }
            other => panic!("expected the lookup, got {other:?}"),
        }
    }

    #[test]
    fn an_out_of_union_status_falls_back_to_unknown() {
        let mut row = event_row();
        row.insert("status".to_string(), json!("archived"));
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row]))]);
        let event = drive_sync(insert_event::<PgError>(&executor, None, &event_input()))
            .expect("bridge")
            .expect("insert");
        assert_eq!(event.status, EventStatus::Unknown, "deviation 1");

        let mut transition = transition_row();
        transition.insert("from_status".to_string(), json!(null));
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![transition]))]);
        let rows = drive_sync(list_event_transitions::<PgError>(&executor, None, "ev1"))
            .expect("bridge")
            .expect("list");
        assert_eq!(rows[0].input.from_status, None);
    }
}
