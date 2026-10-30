//! Port of `src/server/world-model/services/eventService.ts:1-380` — the event
//! lifecycle service.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `eventService.ts:36-38` (`eventOutcomeLoopKey`) | [`event_outcome_loop_key`] |
//! | `eventService.ts:40-42` (`addHours`) | [`add_hours`] |
//! | `eventService.ts:44-52` (`ALLOWED_STATUS_TRANSITIONS`) | [`allowed_transitions`] |
//! | `eventService.ts:54-71` (`cancelOrResolveOutcomeLoop`) | [`cancel_or_resolve_outcome_loop`] |
//! | `eventService.ts:80-117` (`fetchOrInsertEventTransition`) | [`fetch_or_insert_event_transition`] |
//! | `eventService.ts:119-182` (`applyEventStatusChangeInTx`) | [`apply_event_status_change_in_tx`] |
//! | `eventService.ts:184-191` (`applyEventStatusChange`) | [`apply_event_status_change`] |
//! | `eventService.ts:197-201` (`applyPlanChange`) | [`apply_plan_change`] |
//! | `eventService.ts:203-208` (`applyPlanChangeInTx`) | [`apply_plan_change_in_tx`] |
//! | `eventService.ts:215-322` (`planEvent`) | [`plan_event`] |
//! | `eventService.ts:330-342` (`confirmEventOutcome`) | [`confirm_event_outcome`] |
//! | `eventService.ts:344-358` (`confirmEventOutcomeInTx`) | [`confirm_event_outcome_in_tx`] |
//! | `eventService.ts:360-364` (`getEventHistory`) | [`get_event_history`] |
//! | `eventService.ts:366-378` (`resolveEventOpenLoop`) | [`resolve_event_open_loop`] |
//!
//! `recordObservation`/`RecordObservationResult` are re-exported from the
//! observation service (`eventService.ts:33-34`); the re-export carries no
//! behaviour, so it is the one place this port does not duplicate a definition.
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `withWorldModelTransaction`
//!    (`db.ts:204-229`) reads `getWorldModelScope()` from `AsyncLocalStorage`;
//!    the port takes the [`WorldModelScope`] as an argument (see the module
//!    header of [`crate::world_model`]).
//! 2. **`new Date(iso).getTime() + hours * 3600_000`** ([`add_hours`]) parses the
//!    RFC3339 text and re-emits `Date#toISOString()` (millisecond precision, `Z`).
//!    An unparsable input cannot produce a `RangeError` in Rust, so the input is
//!    returned unchanged instead.
//! 3. **A service-level failure is a [`PgError`].** The source throws a plain
//!    `Error`; the port keeps the literal message but wraps it in the seam's
//!    error type.

use serde_json::json;

use crate::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgRow, PgSession, PgStatement, PgValue,
};
use crate::world_model::repositories::ambient_transaction;
use crate::world_model::repositories::event_repository::{
    get_event_by_id, insert_event, insert_event_transition, list_event_timeline,
    update_event_status, EventScope, EventTimelinePoint,
};
use crate::world_model::repositories::observation_repository::insert_observation_with_result;
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::repositories::prospective_repository::{
    get_open_loop_by_key, insert_open_loop, update_open_loop_status,
};
use crate::world_model::repositories::{row_number, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{
    EventInput, EventRecord, EventStatus, EventTransition, EventTransitionInput, ObservationInput,
    OpenLoopInput, OpenLoopRecord, OpenLoopStatus, OpenLoopType, OutboxEventInput,
};

pub use crate::world_model::services::observation_service::{
    record_observation, RecordObservationResult as ObservationRecordResult,
};

/// `[world-model] completed/no_show requires confirmEventOutcome()` —
/// `eventService.ts:125`.
pub const OUTCOME_REQUIRES_CONFIRMATION: &str =
    "[world-model] completed/no_show requires confirmEventOutcome()";

/// `[world-model] plan observation scope must match event scope` — `:231`.
pub const PLAN_SCOPE_MISMATCH: &str = "[world-model] plan observation scope must match event scope";

/// `[world-model] plan observation workspace must match event scope` — `:238`.
pub const PLAN_WORKSPACE_MISMATCH: &str =
    "[world-model] plan observation workspace must match event scope";

/// `eventOutcomeLoopKey(eventId)` — `eventService.ts:36-38`.
pub fn event_outcome_loop_key(event_id: &str) -> String {
    format!("event-outcome:{event_id}")
}

/// `addHours(iso, hours)` — `eventService.ts:40-42` (deviation 2).
pub fn add_hours(iso: &str, hours: i64) -> String {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(parsed) => (parsed + chrono::Duration::hours(hours))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        Err(_) => iso.to_string(),
    }
}

/// The union literal of an [`EventStatus`] (`types.ts:10-17`).
pub(crate) fn status_text(status: EventStatus) -> &'static str {
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

/// The `status` column of a transition row back into the enum.
fn status_from_column(text: &str) -> EventStatus {
    serde_json::from_value(serde_json::Value::String(text.to_string()))
        .unwrap_or(EventStatus::Unknown)
}

/// `ALLOWED_STATUS_TRANSITIONS[status]` — `eventService.ts:44-52`.
pub fn allowed_transitions(status: EventStatus) -> &'static [EventStatus] {
    match status {
        EventStatus::Proposed => &[EventStatus::Planned, EventStatus::Cancelled],
        EventStatus::Planned => &[
            EventStatus::InProgress,
            EventStatus::Completed,
            EventStatus::NoShow,
            EventStatus::Cancelled,
        ],
        EventStatus::InProgress => &[
            EventStatus::Completed,
            EventStatus::NoShow,
            EventStatus::Cancelled,
        ],
        EventStatus::Completed => &[],
        EventStatus::Cancelled => &[],
        EventStatus::NoShow => &[],
        EventStatus::Unknown => &[EventStatus::Planned, EventStatus::Cancelled],
    }
}

/// `ApplyEventStatusChangeInput` from `eventService.ts:73-78`.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyEventStatusChangeInput {
    pub event_id: String,
    pub to_status: EventStatus,
    pub observation: ObservationInput,
    pub reason: Option<String>,
}

/// `PlanChangeResult` from `eventService.ts:24-31`.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanChangeResult {
    Changed {
        kind: EventStatus,
        event: EventRecord,
        transition: EventTransition,
    },
    Unchanged {
        event: EventRecord,
    },
    NotFound,
}

/// `ConfirmEventOutcomeInput` from `eventService.ts:324-328`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmEventOutcomeInput {
    pub event_id: String,
    pub observation: ObservationInput,
    pub outcome: EventOutcome,
}

/// The `'completed' | 'no_show'` outcome union of `:327`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventOutcome {
    Completed,
    NoShow,
}

impl EventOutcome {
    fn to_status(self) -> EventStatus {
        match self {
            EventOutcome::Completed => EventStatus::Completed,
            EventOutcome::NoShow => EventStatus::NoShow,
        }
    }

    fn text(self) -> &'static str {
        match self {
            EventOutcome::Completed => "completed",
            EventOutcome::NoShow => "no_show",
        }
    }
}

/// The input of `planEvent` from `eventService.ts:215-226`.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanEventInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub event_type: String,
    pub scheduled_for: Option<String>,
    pub ends_at: Option<String>,
    pub subject_entity_id: Option<String>,
    pub counterpart_entity_id: Option<String>,
    pub observation: ObservationInput,
}

/// `PlannedEventWithFollowup` from `eventService.ts:210-213`.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEventWithFollowup {
    pub event: EventRecord,
    pub open_loop: Option<OpenLoopRecord>,
}

/// The `SELECT … WHERE event_id = $1 AND source_observation_id = $2 AND
/// to_status = $3 LIMIT 1` of `eventService.ts:97-100`.
const SQL_EXISTING_TRANSITION: &str = "SELECT id, event_id, from_status, to_status, reason, source_observation_id, confidence, transitioned_at\n     FROM world_model_event_transitions\n     WHERE event_id = $1 AND source_observation_id = $2 AND to_status = $3\n     LIMIT 1";

/// The row mapping of `eventService.ts:104-114`.
fn transition_from_row(row: &PgRow) -> EventTransition {
    EventTransition {
        input: EventTransitionInput {
            event_id: row_text(row, "event_id"),
            to_status: status_from_column(&row_text(row, "to_status")),
            from_status: row_optional_text(row, "from_status")
                .map(|text| status_from_column(&text)),
            reason: row_optional_text(row, "reason"),
            source_observation_id: row_optional_text(row, "source_observation_id"),
            confidence: Some(row_number(row, "confidence")),
            transitioned_at: row_optional_text(row, "transitioned_at"),
        },
        id: row_text(row, "id"),
        transitioned_at: row_text(row, "transitioned_at"),
    }
}

/// The transaction executor a running [`ambient_transaction`] hands to the
/// `*InTx` functions: it issues statements on the open session and refuses a
/// nested `connect()` — the same private adapter as the sibling services.
struct SessionExecutor(std::sync::Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<std::sync::Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

/// `fetchOrInsertEventTransition(db, eventId, sourceObservationId, toStatus, build)`
/// — `eventService.ts:80-117`.
///
/// The `build` callback of `:142-152` is inlined because it is the only
/// construction site.
async fn fetch_or_insert_event_transition(
    executor: &dyn PgExecutor,
    event_id: &str,
    source_observation_id: &str,
    from_status: EventStatus,
    to_status: EventStatus,
    reason: Option<&str>,
) -> Result<EventTransition, PgError> {
    let existing = executor
        .query(PgStatement::with_params(
            SQL_EXISTING_TRANSITION,
            vec![
                PgValue::text(event_id),
                PgValue::text(source_observation_id),
                PgValue::text(status_text(to_status)),
            ],
        ))
        .await?;
    if let Some(row) = existing.first() {
        return Ok(transition_from_row(row));
    }
    insert_event_transition::<PgError>(
        executor,
        None,
        &EventTransitionInput {
            event_id: event_id.to_string(),
            from_status: Some(from_status),
            to_status,
            reason: reason.map(str::to_string),
            source_observation_id: Some(source_observation_id.to_string()),
            confidence: None,
            transitioned_at: None,
        },
    )
    .await
}

/// `cancelOrResolveOutcomeLoop(event, status, db)` — `eventService.ts:54-71`.
async fn cancel_or_resolve_outcome_loop(
    executor: &dyn PgExecutor,
    event: &EventRecord,
    status: EventStatus,
) -> Result<(), PgError> {
    let loop_record = get_open_loop_by_key::<PgError>(
        executor,
        None,
        &event.input.user_id,
        &event.input.persona_id,
        &event_outcome_loop_key(&event.id),
        event.input.workspace_id.as_deref().unwrap_or(""),
    )
    .await?;
    let loop_record = match loop_record {
        Some(loop_record) => loop_record,
        None => return Ok(()),
    };
    let target_status = if status == EventStatus::Cancelled {
        OpenLoopStatus::Cancelled
    } else {
        OpenLoopStatus::Resolved
    };
    if matches!(
        loop_record.status,
        OpenLoopStatus::Open | OpenLoopStatus::Scheduled | OpenLoopStatus::Asked
    ) {
        update_open_loop_status::<PgError>(
            executor,
            None,
            &loop_record.id,
            target_status,
            None,
            None,
            None,
            Some(&format!("event became {}", status_text(status))),
        )
        .await?;
    }
    Ok(())
}

/// The `scope?: Pick<EventInput, …>` filter of `getEventById` built from the
/// observation (`eventService.ts:128`, `:155`).
fn observation_filter(observation: &ObservationInput) -> Option<EventScope> {
    Some(EventScope {
        user_id: observation.user_id.clone(),
        persona_id: observation.persona_id.clone(),
        workspace_id: observation.workspace_id.clone(),
    })
}

/// `applyEventStatusChangeInTx(input, allowOutcome, db)` —
/// `eventService.ts:119-182`.
pub async fn apply_event_status_change_in_tx(
    executor: &dyn PgExecutor,
    input: &ApplyEventStatusChangeInput,
    allow_outcome: bool,
) -> Result<PlanChangeResult, PgError> {
    if matches!(
        input.to_status,
        EventStatus::Completed | EventStatus::NoShow
    ) && !allow_outcome
    {
        return Err(PgError::new(OUTCOME_REQUIRES_CONFIRMATION));
    }

    let event = get_event_by_id::<PgError>(
        executor,
        None,
        &input.event_id,
        observation_filter(&input.observation).as_ref(),
    )
    .await?;
    let event = match event {
        Some(event) => event,
        None => return Ok(PlanChangeResult::NotFound),
    };
    if event.status == input.to_status {
        return Ok(PlanChangeResult::Unchanged { event });
    }
    if !allowed_transitions(event.status).contains(&input.to_status) {
        return Err(PgError::new(format!(
            "[world-model] invalid event transition {} -> {}",
            status_text(event.status),
            status_text(input.to_status)
        )));
    }

    let observation_result =
        insert_observation_with_result::<PgError>(executor, None, &input.observation).await?;
    let observation = observation_result.observation;
    let transition = fetch_or_insert_event_transition(
        executor,
        &event.id,
        &observation.id,
        event.status,
        input.to_status,
        input.reason.as_deref(),
    )
    .await?;
    update_event_status::<PgError>(
        executor,
        None,
        &event.id,
        input.to_status,
        Some(&observation.input.occurred_at),
    )
    .await?;
    let updated = get_event_by_id::<PgError>(
        executor,
        None,
        &event.id,
        observation_filter(&input.observation).as_ref(),
    )
    .await?;
    let updated = match updated {
        Some(event) => event,
        None => return Ok(PlanChangeResult::NotFound),
    };

    if matches!(
        input.to_status,
        EventStatus::Cancelled | EventStatus::Completed | EventStatus::NoShow
    ) {
        cancel_or_resolve_outcome_loop(executor, &updated, input.to_status).await?;
    }
    enqueue_outbox_event::<PgError>(
        executor,
        None,
        &OutboxEventInput {
            event_type: "world.event.status_changed".to_string(),
            aggregate_type: "event".to_string(),
            aggregate_id: updated.id.clone(),
            payload: json!({
                "userId": updated.input.user_id,
                "personaId": updated.input.persona_id,
                "workspaceId": updated.input.workspace_id.clone().unwrap_or_default(),
                "fromStatus": status_text(event.status),
                "toStatus": status_text(updated.status),
                "observationId": observation.id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            idempotency_key: None,
            correlation_id: None,
            user_id: None,
            persona_id: None,
            workspace_id: None,
        },
    )
    .await?;
    Ok(PlanChangeResult::Changed {
        kind: input.to_status,
        event: updated,
        transition,
    })
}

/// `applyEventStatusChange(input, allowOutcome)` — `eventService.ts:184-191`.
pub async fn apply_event_status_change(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ApplyEventStatusChangeInput,
    allow_outcome: bool,
) -> Result<PlanChangeResult, PgError> {
    let input = input.clone();
    ambient_transaction::<PlanChangeResult, PgError>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                apply_event_status_change_in_tx(&transaction_executor, &input, allow_outcome).await
            })
        }),
    )
    .await
}

/// `applyPlanChange(input)` — `eventService.ts:197-201`.
pub async fn apply_plan_change(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ApplyEventStatusChangeInput,
) -> Result<PlanChangeResult, PgError> {
    apply_event_status_change(executor, scope, input, false).await
}

/// `applyPlanChangeInTx(input, db)` — `eventService.ts:203-208`.
pub async fn apply_plan_change_in_tx(
    executor: &dyn PgExecutor,
    input: &ApplyEventStatusChangeInput,
) -> Result<PlanChangeResult, PgError> {
    apply_event_status_change_in_tx(executor, input, false).await
}

/// `planEvent(input)` — `eventService.ts:215-322`.
pub async fn plan_event(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &PlanEventInput,
) -> Result<PlannedEventWithFollowup, PgError> {
    if input.observation.user_id != input.user_id
        || input.observation.persona_id != input.persona_id
    {
        return Err(PgError::new(PLAN_SCOPE_MISMATCH));
    }
    if input.workspace_id.is_some()
        && input.observation.workspace_id.is_some()
        && input.workspace_id != input.observation.workspace_id
    {
        return Err(PgError::new(PLAN_WORKSPACE_MISMATCH));
    }
    let input = input.clone();
    ambient_transaction::<PlannedEventWithFollowup, PgError>(
        executor,
        scope,
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(session);
                plan_event_in_tx(&transaction_executor, &input).await
            })
        }),
    )
    .await
}

/// The `withWorldModelTransaction` callback of `:240-321`.
async fn plan_event_in_tx(
    executor: &dyn PgExecutor,
    input: &PlanEventInput,
) -> Result<PlannedEventWithFollowup, PgError> {
    let workspace_id = input
        .workspace_id
        .clone()
        .or_else(|| input.observation.workspace_id.clone())
        .unwrap_or_default();
    let event = insert_event::<PgError>(
        executor,
        None,
        &EventInput {
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            workspace_id: Some(workspace_id.clone()),
            title: input.title.clone(),
            event_type: input.event_type.clone(),
            subject_entity_id: input.subject_entity_id.clone(),
            counterpart_entity_id: input.counterpart_entity_id.clone(),
            scheduled_for: input.scheduled_for.clone(),
            ends_at: input.ends_at.clone(),
            status: Some(EventStatus::Planned),
            observed_at: None,
            idempotency_key: None,
            replaces_event_id: None,
        },
    )
    .await?;

    let observation_result =
        insert_observation_with_result::<PgError>(executor, None, &input.observation).await?;
    let observation = observation_result.observation;
    insert_event_transition::<PgError>(
        executor,
        None,
        &EventTransitionInput {
            event_id: event.id.clone(),
            from_status: None,
            to_status: EventStatus::Planned,
            reason: Some("plan announced".to_string()),
            source_observation_id: Some(observation.id.clone()),
            confidence: None,
            transitioned_at: None,
        },
    )
    .await?;

    let follow_up_at = match (&input.ends_at, &input.scheduled_for) {
        (Some(ends_at), _) => Some(add_hours(ends_at, 1)),
        (None, Some(scheduled_for)) => Some(add_hours(scheduled_for, 1)),
        (None, None) => None,
    };
    let open_loop = insert_open_loop::<PgError>(
        executor,
        None,
        &OpenLoopInput {
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            workspace_id: Some(workspace_id.clone()),
            loop_type: OpenLoopType::EventOutcome,
            subject_id: input.subject_entity_id.clone(),
            question: Some(format!("How did \"{}\" go?", event.input.title)),
            missing_information: None,
            importance: Some(2.0),
            trigger_at: follow_up_at,
            do_not_ask_before: None,
            deduplication_key: event_outcome_loop_key(&event.id),
            max_attempts: None,
        },
    )
    .await?;

    if observation_result.created {
        let mut payload = input.observation.payload.clone();
        payload.insert("userId".to_string(), json!(input.user_id));
        payload.insert("personaId".to_string(), json!(input.persona_id));
        payload.insert("workspaceId".to_string(), json!(workspace_id));
        enqueue_outbox_event::<PgError>(
            executor,
            None,
            &OutboxEventInput {
                event_type: "world.observation.created".to_string(),
                aggregate_type: "observation".to_string(),
                aggregate_id: observation.id.clone(),
                payload,
                idempotency_key: None,
                correlation_id: None,
                user_id: None,
                persona_id: None,
                workspace_id: None,
            },
        )
        .await?;
    }
    enqueue_outbox_event::<PgError>(
        executor,
        None,
        &OutboxEventInput {
            event_type: "world.event.created".to_string(),
            aggregate_type: "event".to_string(),
            aggregate_id: event.id.clone(),
            payload: json!({
                "userId": input.user_id,
                "personaId": input.persona_id,
                "workspaceId": workspace_id,
                "title": event.input.title,
                "eventType": event.input.event_type,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            idempotency_key: None,
            correlation_id: None,
            user_id: None,
            persona_id: None,
            workspace_id: None,
        },
    )
    .await?;
    Ok(PlannedEventWithFollowup {
        event,
        open_loop: Some(open_loop),
    })
}

/// `confirmEventOutcome(input)` — `eventService.ts:330-342`.
pub async fn confirm_event_outcome(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ConfirmEventOutcomeInput,
) -> Result<PlanChangeResult, PgError> {
    apply_event_status_change(
        executor,
        scope,
        &ApplyEventStatusChangeInput {
            event_id: input.event_id.clone(),
            to_status: input.outcome.to_status(),
            observation: input.observation.clone(),
            reason: Some(format!("outcome confirmed as {}", input.outcome.text())),
        },
        true,
    )
    .await
}

/// `confirmEventOutcomeInTx(input, db)` — `eventService.ts:344-358`.
pub async fn confirm_event_outcome_in_tx(
    executor: &dyn PgExecutor,
    input: &ConfirmEventOutcomeInput,
) -> Result<PlanChangeResult, PgError> {
    apply_event_status_change_in_tx(
        executor,
        &ApplyEventStatusChangeInput {
            event_id: input.event_id.clone(),
            to_status: input.outcome.to_status(),
            observation: input.observation.clone(),
            reason: Some(format!("outcome confirmed as {}", input.outcome.text())),
        },
        true,
    )
    .await
}

/// `getEventHistory(eventId)` — `eventService.ts:360-364`.
pub async fn get_event_history(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event_id: &str,
) -> Result<Vec<EventTimelinePoint>, PgError> {
    list_event_timeline::<PgError>(executor, scope, event_id).await
}

/// `resolveEventOpenLoop(eventId)` — `eventService.ts:366-378`.
pub async fn resolve_event_open_loop(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event_id: &str,
) -> Result<(), PgError> {
    let event = get_event_by_id::<PgError>(executor, scope, event_id, None).await?;
    let event = match event {
        Some(event) => event,
        None => return Ok(()),
    };
    let loop_record = get_open_loop_by_key::<PgError>(
        executor,
        scope,
        &event.input.user_id,
        &event.input.persona_id,
        &event_outcome_loop_key(&event.id),
        event.input.workspace_id.as_deref().unwrap_or(""),
    )
    .await?;
    if let Some(loop_record) = loop_record {
        if matches!(
            loop_record.status,
            OpenLoopStatus::Open | OpenLoopStatus::Scheduled | OpenLoopStatus::Asked
        ) {
            update_open_loop_status::<PgError>(
                executor,
                scope,
                &loop_record.id,
                OpenLoopStatus::Resolved,
                None,
                None,
                None,
                Some(&format!("event became {}", status_text(event.status))),
            )
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use crate::world_model::types::ObservationSourceType;
    use serde_json::{json, Map};

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row object").clone()
    }

    fn event_row(id: &str, status: &str) -> PgRow {
        row(json!({
            "id": id, "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
            "title": "Dinner", "event_type": "dinner", "subject_entity_id": null,
            "counterpart_entity_id": null, "scheduled_for": "2026-10-11T18:00:00Z",
            "ends_at": null, "status": status, "observed_at": null,
            "created_at": "2026-10-11T10:00:00.000Z", "updated_at": "2026-10-11T10:00:00.000Z",
            "idempotency_key": null, "replaces_event_id": null
        }))
    }

    fn observation_row() -> PgRow {
        row(json!({
            "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
            "source_type": "chat_message", "source_id": "m1",
            "occurred_at": "2026-10-11T10:05:00.000Z", "received_at": "2026-10-11T10:05:00.000Z",
            "payload": { "text": "yes" }, "source_authority": "user"
        }))
    }

    fn transition_row() -> PgRow {
        row(json!({
            "id": "t1", "event_id": "e1", "from_status": "planned", "to_status": "in_progress",
            "reason": "progress", "source_observation_id": "o1", "confidence": 0.8,
            "transitioned_at": "2026-10-11T10:05:00.000Z"
        }))
    }

    fn outbox_row() -> PgRow {
        row(json!({
            "id": "x1", "event_type": "world.event.status_changed", "aggregate_type": "event",
            "aggregate_id": "e1", "payload": {}, "status": "pending", "attempts": 0,
            "error_message": null, "created_at": "2026-10-11T10:05:00.000Z",
            "dispatched_at": null, "idempotency_key": null, "correlation_id": null,
            "user_id": null, "persona_id": null, "workspace_id": null, "inserted": true
        }))
    }

    fn observation() -> ObservationInput {
        ObservationInput {
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: Some("w1".into()),
            source_type: ObservationSourceType::ChatMessage,
            source_id: "m1".into(),
            occurred_at: "2026-10-11T10:05:00.000Z".into(),
            payload: Map::new(),
            source_authority: Some("user".into()),
        }
    }

    #[test]
    fn add_hours_reemits_iso_string() {
        assert_eq!(
            add_hours("2026-10-11T18:00:00Z", 1),
            "2026-10-11T19:00:00.000Z"
        );
        assert_eq!(add_hours("not-a-date", 3), "not-a-date");
    }

    #[test]
    fn the_transition_table_and_loop_key_match_the_source() {
        assert_eq!(event_outcome_loop_key("e1"), "event-outcome:e1");
        assert!(allowed_transitions(EventStatus::Planned).contains(&EventStatus::Cancelled));
        assert!(!allowed_transitions(EventStatus::Completed).contains(&EventStatus::Planned));
    }

    #[test]
    fn an_outcome_without_confirmation_is_rejected_before_any_sql() {
        let executor = RecordingExecutor::new(vec![]);
        let error = drive_sync(apply_event_status_change_in_tx(
            &executor,
            &ApplyEventStatusChangeInput {
                event_id: "e1".into(),
                to_status: EventStatus::Completed,
                observation: observation(),
                reason: None,
            },
            false,
        ))
        .expect("bridge")
        .expect_err("outcome needs confirmation");
        assert_eq!(error.message, OUTCOME_REQUIRES_CONFIRMATION);
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn an_unchanged_status_is_reported_without_writes() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row(
            "e1",
            "in_progress",
        )]))]);
        let result = drive_sync(apply_event_status_change_in_tx(
            &executor,
            &ApplyEventStatusChangeInput {
                event_id: "e1".into(),
                to_status: EventStatus::InProgress,
                observation: observation(),
                reason: None,
            },
            false,
        ))
        .expect("bridge")
        .expect("result");
        assert!(matches!(result, PlanChangeResult::Unchanged { .. }));
        assert_eq!(executor.calls().len(), 1, "only the read");
    }

    #[test]
    fn an_invalid_transition_keeps_the_literal_message() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row(
            "e1",
            "completed",
        )]))]);
        let error = drive_sync(apply_event_status_change_in_tx(
            &executor,
            &ApplyEventStatusChangeInput {
                event_id: "e1".into(),
                to_status: EventStatus::Planned,
                observation: observation(),
                reason: None,
            },
            true,
        ))
        .expect("bridge")
        .expect_err("invalid transition");
        assert_eq!(
            error.message,
            "[world-model] invalid event transition completed -> planned"
        );
    }

    #[test]
    fn a_status_change_writes_observation_transition_status_and_outbox() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row("e1", "planned")])),
            Ok(PgQueryResult::from_rows(vec![observation_row()])),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![transition_row()])),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![event_row(
                "e1",
                "in_progress",
            )])),
            Ok(PgQueryResult::from_rows(vec![outbox_row()])),
        ]);
        let result = drive_sync(apply_event_status_change_in_tx(
            &executor,
            &ApplyEventStatusChangeInput {
                event_id: "e1".into(),
                to_status: EventStatus::InProgress,
                observation: observation(),
                reason: Some("progress".into()),
            },
            false,
        ))
        .expect("bridge")
        .expect("result");
        match result {
            PlanChangeResult::Changed {
                kind,
                event,
                transition,
            } => {
                assert_eq!(kind, EventStatus::InProgress);
                assert_eq!(event.status, EventStatus::InProgress);
                assert_eq!(transition.input.to_status, EventStatus::InProgress);
                assert_eq!(transition.id, "t1");
            }
            other => panic!("expected a change, got {other:?}"),
        }
        let calls = executor.calls();
        assert_eq!(calls.len(), 7);
        assert!(calls[0].sql().starts_with("SELECT id, user_id"));
        assert!(calls[1]
            .sql()
            .contains("INSERT INTO world_model_observations"));
        assert!(calls[2].sql().contains("world_model_event_transitions"));
        assert!(calls[3]
            .sql()
            .contains("INSERT INTO world_model_event_transitions"));
        assert!(calls[4].sql().contains("UPDATE world_model_events"));
        assert!(calls[6]
            .sql()
            .contains("INSERT INTO world_model_outbox_events"));
    }

    #[test]
    fn planning_requires_a_matching_observation_scope() {
        let executor = RecordingExecutor::new(vec![]);
        let mut obs = observation();
        obs.user_id = "other".into();
        let error = drive_sync(plan_event(
            &executor,
            None,
            &PlanEventInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: None,
                title: "Dinner".into(),
                event_type: "dinner".into(),
                scheduled_for: None,
                ends_at: None,
                subject_entity_id: None,
                counterpart_entity_id: None,
                observation: obs,
            },
        ))
        .expect("bridge")
        .expect_err("scope mismatch");
        assert_eq!(error.message, PLAN_SCOPE_MISMATCH);
        assert!(executor.calls().is_empty());
    }
}
