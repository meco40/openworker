//! Port of `src/server/world-model/services/openLoopService.ts:1-341` — the
//! delivery loop of the prospective runtime.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `openLoopService.ts:16-19` (`ChannelDeliveryResult`) | [`ChannelDeliveryResult`] |
//! | `openLoopService.ts:23-30` (`DeliveryPolicyContext`) | [`DeliveryPolicyContext`] |
//! | `openLoopService.ts:63-70` (`DeliverDueOpenLoopsResult`) | [`DeliverDueOpenLoopsResult`] |
//! | `openLoopService.ts:76-187` (`deliverDueOpenLoops`) | [`deliver_due_open_loops`] |
//! | `openLoopService.ts:189-192` (`calculateRetryAt`) | [`calculate_retry_at`] |
//! | `openLoopService.ts:231-248` (`enqueueOpenLoopDelivery`) | [`enqueue_open_loop_delivery`] |
//! | `openLoopService.ts:255-278` (`enqueueAndMarkAsked`) | [`enqueue_and_mark_asked`] |
//! | `openLoopService.ts:280-290` (`resolveOpenLoopAsAnswered`) | [`resolve_open_loop_as_answered`] |
//! | `openLoopService.ts:292-308` (`resolveOpenLoopAsAnsweredInTx`) | [`resolve_open_loop_as_answered_in_tx`] |
//! | `openLoopService.ts:310-341` (`claimAndDeliver…InTransaction`) | [`claim_and_deliver_due_open_loops_within_transaction`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** The source calls
//!    `markOpenLoopAsked(loop.id, now)` and friends without a scope, so
//!    `getWorldModelScope()` decides. The port passes
//!    `Option<&WorldModelScope>` to every repository call, exactly like the
//!    repositories themselves document.
//! 2. **`OpenLoopServiceDeps` is not a struct of optional closures.** Rust has no
//!    optional-property object; the port keeps the two seams the production
//!    runtime actually uses as parameters — `deliver` for the explicitly
//!    injected direct delivery (`:89`, `:93`) and the `now`-function replaced by
//!    the `now: &str` argument — and wires every other dependency to its
//!    productive default, which is what the source does when `depsOverride` is
//!    absent (`:85-92`).
//! 3. **The wall clock is passed in.** `:84` is `new Date().toISOString()`; the
//!    port takes `now`, so the policy and the retry calculation are
//!    deterministic. `countAskedOpenLoopsToday` keeps the source's own
//!    `startOfDay` (`prospectiveRepository.ts:455-456`), computed here from
//!    `now`.
//! 4. **A missing `deliver` is `hasDirectDelivery === false`.** The port models
//!    `deps?.deliver` as `Option<DirectDeliver>`, and the fallback deliverer of
//!    `:218-220` only exists for the branch in which one is injected.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{BoxFuture, PgError, PgExecutor};
use crate::world_model::repositories::outbox_repository::enqueue_outbox_event;
use crate::world_model::repositories::prospective_repository::{
    claim_due_open_loop, count_asked_open_loops_today, list_due_open_loops, mark_open_loop_asked,
    release_open_loop_lease, update_open_loop_status,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::follow_up_policy::{
    decide_open_loop_delivery, DeliveryDecisionReason, FollowUpContext,
};
use crate::world_model::services::notification_policy::{
    decide_notification, NotificationDecisionReason, NotificationPolicyConfig, QuietHours,
};
use crate::world_model::types::{OpenLoopRecord, OpenLoopStatus, OutboxEventInput};

/// `ChannelDeliveryResult` from `openLoopService.ts:16-19`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelDeliveryResult {
    pub ok: bool,
    pub provider_message_id: Option<String>,
}

/// `DeliveryPolicyContext` from `openLoopService.ts:23-30`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryPolicyContext {
    pub now: String,
    pub channel_available: Option<bool>,
    pub quiet_hours: Option<QuietHours>,
    pub daily_budget: Option<f64>,
    pub delivered_today: Option<f64>,
    pub user_interaction_active: Option<bool>,
}

/// `DeliverDueOpenLoopsResult` from `openLoopService.ts:63-70`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliverDueOpenLoopsResult {
    pub total_due: usize,
    pub delivered: i64,
    pub enqueued: i64,
    pub rejected: i64,
    pub failed: i64,
    pub reasons: BTreeMap<String, i64>,
}

impl DeliverDueOpenLoopsResult {
    /// The zero result the prospective runtime substitutes on failure
    /// (`runtime/prospectiveRuntime.ts:35-42`).
    pub fn empty() -> Self {
        Self {
            total_due: 0,
            delivered: 0,
            enqueued: 0,
            rejected: 0,
            failed: 0,
            reasons: BTreeMap::new(),
        }
    }
}

/// `deps.deliver` of `openLoopService.ts:56`.
pub type DirectDeliver<'a> =
    &'a (dyn Fn(OpenLoopRecord) -> BoxFuture<'static, ChannelDeliveryResult> + Send + Sync);

/// `calculateRetryAt(now, attempts)` — `openLoopService.ts:189-192`.
///
/// `Math.min(6h, 60_000 * 2 ** Math.min(attempts, 8))`, then
/// `new Date(new Date(now).getTime() + backoffMs).toISOString()`.
pub fn calculate_retry_at(now: &str, attempts: i64) -> String {
    let exponent = attempts.clamp(0, 8) as u32;
    let backoff_ms = (60_000_i64 * 2_i64.pow(exponent)).min(6 * 60 * 60 * 1000);
    chrono::DateTime::parse_from_rfc3339(now)
        .map(|instant| {
            (instant + chrono::Duration::milliseconds(backoff_ms))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| now.to_string())
}

/// The literal of a [`DeliveryDecisionReason`] (`followUpPolicy.ts:12`).
fn delivery_reason_text(reason: DeliveryDecisionReason) -> &'static str {
    match reason {
        DeliveryDecisionReason::Allow => "allow",
        DeliveryDecisionReason::QuietTime => "quiet_time",
        DeliveryDecisionReason::BudgetExceeded => "budget_exceeded",
        DeliveryDecisionReason::ChannelUnavailable => "channel_unavailable",
        DeliveryDecisionReason::UserActive => "user_active",
    }
}

/// The literal of a [`NotificationDecisionReason`] (`notificationPolicy.ts:13`).
fn notification_reason_text(reason: NotificationDecisionReason) -> &'static str {
    match reason {
        NotificationDecisionReason::Allow => "allow",
        NotificationDecisionReason::QuietTime => "quiet_time",
        NotificationDecisionReason::BudgetExceeded => "budget_exceeded",
        NotificationDecisionReason::ChannelClosed => "channel_closed",
    }
}

/// The `status` literal the policy compares against (`followUpPolicy.ts:31`).
fn open_loop_status_text(status: OpenLoopStatus) -> &'static str {
    match status {
        OpenLoopStatus::Open => "open",
        OpenLoopStatus::Scheduled => "scheduled",
        OpenLoopStatus::Asked => "asked",
        OpenLoopStatus::Answered => "answered",
        OpenLoopStatus::Resolved => "resolved",
        OpenLoopStatus::Cancelled => "cancelled",
        OpenLoopStatus::Expired => "expired",
    }
}

/// `startOfDay` of `prospectiveRepository.ts:455-456`.
fn start_of_day(now: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(now)
        .ok()
        .and_then(|instant| {
            instant.date_naive().and_hms_opt(0, 0, 0).map(|midnight| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(midnight, chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
        })
        .unwrap_or_else(|| now.to_string())
}

fn bump(result: &mut DeliverDueOpenLoopsResult, reason: &str) {
    *result.reasons.entry(reason.to_string()).or_insert(0) += 1;
}

/// The `payload` object literal shared by `:240-246` and `:266-272`.
fn delivery_payload(loop_record: &OpenLoopRecord) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert(
        "userId".into(),
        Value::String(loop_record.input.user_id.clone()),
    );
    payload.insert(
        "personaId".into(),
        Value::String(loop_record.input.persona_id.clone()),
    );
    payload.insert(
        "workspaceId".into(),
        Value::String(loop_record.input.workspace_id.clone().unwrap_or_default()),
    );
    payload.insert("openLoopId".into(), Value::String(loop_record.id.clone()));
    payload.insert(
        "question".into(),
        match &loop_record.input.question {
            Some(question) => Value::String(question.clone()),
            None => Value::Null,
        },
    );
    payload
}

/// The `enqueueOutboxEvent` input of `:232-247` and `:257-275`.
fn delivery_outbox_input(loop_record: &OpenLoopRecord) -> OutboxEventInput {
    OutboxEventInput {
        event_type: "proactive.question.requested".to_string(),
        aggregate_type: "open_loop".to_string(),
        aggregate_id: loop_record.id.clone(),
        payload: delivery_payload(loop_record),
        idempotency_key: Some(format!(
            "proactive-question:{}:{}",
            loop_record.id, loop_record.attempts
        )),
        correlation_id: None,
        user_id: Some(loop_record.input.user_id.clone()),
        persona_id: Some(loop_record.input.persona_id.clone()),
        workspace_id: Some(loop_record.input.workspace_id.clone().unwrap_or_default()),
    }
}

/// `enqueueOpenLoopDelivery(loop)` — `openLoopService.ts:231-248`.
pub async fn enqueue_open_loop_delivery(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_record: &OpenLoopRecord,
) -> Result<(), PgError> {
    enqueue_outbox_event::<PgError>(executor, scope, &delivery_outbox_input(loop_record)).await?;
    Ok(())
}

/// `resolveOpenLoopAsAnswered(loopId, observationId?, note?)` —
/// `openLoopService.ts:280-290`.
pub async fn resolve_open_loop_as_answered(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_id: &str,
    observation_id: Option<&str>,
    note: Option<&str>,
    now: &str,
) -> Result<(), PgError> {
    update_open_loop_status::<PgError>(
        executor,
        scope,
        loop_id,
        OpenLoopStatus::Answered,
        Some(now),
        None,
        observation_id,
        note,
    )
    .await
}

/// `enqueueAndMarkAsked(loop, now)` — `openLoopService.ts:255-278`.
pub async fn enqueue_and_mark_asked(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_record: &OpenLoopRecord,
    now: &str,
) -> Result<(), PgError> {
    let parts = scope.map(crate::world_model::repositories::normalized_scope);
    let input = delivery_outbox_input(loop_record);
    let loop_id = loop_record.id.clone();
    let now = now.to_string();
    crate::world_model::db::run_scoped(
        executor,
        parts.as_ref(),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(Arc::clone(&session));
                enqueue_outbox_event::<PgError>(&transaction_executor, None, &input).await?;
                mark_open_loop_asked::<PgError>(&transaction_executor, None, &loop_id, &now).await
            })
        }),
    )
    .await
}

/// `resolveOpenLoopAsAnsweredInTx(loopId, observationId, note, db)` —
/// `openLoopService.ts:292-308`.
///
/// `db` is the running transaction's executor; the caller opens it with
/// [`run_scoped`](crate::world_model::db::run_scoped) and passes `None` here so
/// the statement stays in that transaction.
pub async fn resolve_open_loop_as_answered_in_tx(
    transaction_executor: &dyn PgExecutor,
    loop_id: &str,
    observation_id: Option<&str>,
    note: Option<&str>,
    now: &str,
) -> Result<(), PgError> {
    update_open_loop_status::<PgError>(
        transaction_executor,
        None,
        loop_id,
        OpenLoopStatus::Answered,
        Some(now),
        None,
        observation_id,
        note,
    )
    .await
}

/// `claimAndDeliverDueOpenLoopsWithinTransaction(userId, personaId)` —
/// `openLoopService.ts:310-341`.
pub async fn claim_and_deliver_due_open_loops_within_transaction(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    now: &str,
) -> Result<DeliverDueOpenLoopsResult, PgError> {
    let parts = scope.map(crate::world_model::repositories::normalized_scope);
    let user_id = user_id.to_string();
    let persona_id = persona_id.to_string();
    let now = now.to_string();
    crate::world_model::db::run_scoped(
        executor,
        parts.as_ref(),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(Arc::clone(&session));
                let due = list_due_open_loops::<PgError>(
                    &transaction_executor,
                    None,
                    &user_id,
                    &persona_id,
                    &now,
                    "",
                    50,
                )
                .await?;
                for loop_record in &due {
                    let mut input = delivery_outbox_input(loop_record);
                    // The source rebinds userId/personaId from the arguments and
                    // omits workspaceId from the payload (`:323-327`).
                    input.user_id = Some(user_id.clone());
                    input.persona_id = Some(persona_id.clone());
                    input.payload.remove("workspaceId");
                    enqueue_outbox_event::<PgError>(&transaction_executor, None, &input).await?;
                }
                Ok(DeliverDueOpenLoopsResult {
                    total_due: due.len(),
                    delivered: 0,
                    enqueued: due.len() as i64,
                    rejected: 0,
                    failed: 0,
                    reasons: BTreeMap::new(),
                })
            })
        }),
    )
    .await
}

/// The `type` literal of an open loop (`types.ts:28-34`), used as the
/// notification `channel` (`:136`).
fn open_loop_type_text(loop_type: crate::world_model::types::OpenLoopType) -> &'static str {
    use crate::world_model::types::OpenLoopType;
    match loop_type {
        OpenLoopType::Clarification => "clarification",
        OpenLoopType::Confirmation => "confirmation",
        OpenLoopType::EventOutcome => "event_outcome",
        OpenLoopType::Dependency => "dependency",
        OpenLoopType::MissingContext => "missing_context",
        OpenLoopType::PromisedFollowUp => "promised_follow_up",
    }
}

/// `deliverDueOpenLoops(userId, personaId, workspaceId, deps)` —
/// `openLoopService.ts:76-187`.
#[allow(clippy::too_many_arguments)]
pub async fn deliver_due_open_loops(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    now: &str,
    deliver: Option<DirectDeliver<'_>>,
) -> Result<DeliverDueOpenLoopsResult, PgError> {
    let due =
        list_due_open_loops::<PgError>(executor, scope, user_id, persona_id, now, workspace_id, 50)
            .await?;
    let mut result = DeliverDueOpenLoopsResult {
        total_due: due.len(),
        ..DeliverDueOpenLoopsResult::empty()
    };

    let delivered_today = count_asked_open_loops_today::<PgError>(
        executor,
        scope,
        user_id,
        persona_id,
        workspace_id,
        &start_of_day(now),
    )
    .await?;
    let policy_ctx = DeliveryPolicyContext {
        now: now.to_string(),
        channel_available: None,
        quiet_hours: config.quiet_hours.map(|quiet| QuietHours {
            start: quiet.start,
            end: quiet.end,
        }),
        daily_budget: Some(config.daily_proactive_budget as f64),
        delivered_today: Some(delivered_today),
        user_interaction_active: None,
    };
    let notification_config = NotificationPolicyConfig {
        quiet_hours: policy_ctx.quiet_hours,
        daily_budget: Some(config.daily_proactive_budget as f64),
        channel_pref: None,
    };

    for due_loop in &due {
        // Claim one loop atomically with SKIP LOCKED (`:119-128`).
        let claim_workspace = due_loop
            .input
            .workspace_id
            .clone()
            .unwrap_or_else(|| workspace_id.to_string());
        let claimed = claim_due_open_loop::<PgError>(
            executor,
            scope,
            &due_loop.input.user_id,
            &due_loop.input.persona_id,
            now,
            &claim_workspace,
            "scheduler",
            60_000,
        )
        .await?;
        let Some(loop_record) = claimed else {
            continue;
        };

        let decision = decide_open_loop_delivery(
            open_loop_status_text(loop_record.status),
            Some(loop_record.attempts),
            loop_record.input.max_attempts,
            loop_record.input.do_not_ask_before.as_deref(),
            FollowUpContext {
                now: policy_ctx.now.as_str(),
                quiet_hours: policy_ctx.quiet_hours.map(|quiet| (quiet.start, quiet.end)),
                daily_budget: policy_ctx.daily_budget,
                delivered_today: policy_ctx.delivered_today,
                channel_available: policy_ctx.channel_available,
                user_interaction_active: policy_ctx.user_interaction_active,
            },
        );

        // The notification policy is applied on top and evaluated first,
        // exactly like `:134-147` before `:149-154`.
        let notification = decide_notification(
            now,
            open_loop_type_text(loop_record.input.loop_type),
            delivered_today,
            &notification_config,
        );
        if !notification.allow {
            release_open_loop_lease::<PgError>(
                executor,
                scope,
                &loop_record.id,
                Some(&calculate_retry_at(now, loop_record.attempts)),
            )
            .await?;
            result.rejected += 1;
            bump(&mut result, notification_reason_text(notification.reason));
            continue;
        }

        if !decision.allow {
            release_open_loop_lease::<PgError>(
                executor,
                scope,
                &loop_record.id,
                Some(&calculate_retry_at(now, loop_record.attempts)),
            )
            .await?;
            result.rejected += 1;
            bump(&mut result, delivery_reason_text(decision.reason));
            continue;
        }

        if enqueue_open_loop_delivery(executor, scope, &loop_record)
            .await
            .is_err()
        {
            release_open_loop_lease::<PgError>(
                executor,
                scope,
                &loop_record.id,
                Some(&calculate_retry_at(now, loop_record.attempts)),
            )
            .await?;
            result.failed += 1;
            bump(&mut result, "enqueue_failed");
            continue;
        }

        let Some(deliver) = deliver else {
            release_open_loop_lease::<PgError>(executor, scope, &loop_record.id, None).await?;
            result.enqueued += 1;
            continue;
        };

        let delivery = deliver(loop_record.clone()).await;
        if !delivery.ok {
            release_open_loop_lease::<PgError>(
                executor,
                scope,
                &loop_record.id,
                Some(&calculate_retry_at(now, loop_record.attempts)),
            )
            .await?;
            result.failed += 1;
            bump(&mut result, "delivery_failed");
            continue;
        }

        mark_open_loop_asked::<PgError>(executor, scope, &loop_record.id, now).await?;
        result.delivered += 1;
    }

    Ok(result)
}

/// The `client` of a source transaction, as an executor.
struct SessionExecutor(Arc<dyn crate::world_model::db::PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(
        &'a self,
    ) -> BoxFuture<'a, Result<Arc<dyn crate::world_model::db::PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: crate::world_model::db::PgStatement,
    ) -> BoxFuture<'a, Result<crate::world_model::db::PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use serde_json::json;

    fn row(value: Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn loop_row(id: &str, status: &str) -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": id, "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "type": "clarification", "status": status, "subject_id": null,
            "question": "Which city?", "missing_information": null, "importance": 1,
            "trigger_at": null, "do_not_ask_before": null, "last_checked_at": null,
            "deduplication_key": "key", "max_attempts": 3, "attempts": 0,
            "last_asked_at": null, "resolved_observation_id": null, "note": null,
            "created_at": "2026-10-10T10:00:00.000Z", "updated_at": "2026-10-10T10:00:00.000Z"
        }))])
    }

    fn outbox_row() -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": "ob1", "event_type": "proactive.question.requested",
            "aggregate_type": "open_loop", "aggregate_id": "l1", "payload": {},
            "status": "pending", "attempts": 0, "error_message": null,
            "created_at": "2026-10-10T10:00:00.000Z", "dispatched_at": null,
            "idempotency_key": "proactive-question:l1:0", "correlation_id": null,
            "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "inserted": true
        }))])
    }

    fn count_row(count: &str) -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({ "count": count }))])
    }

    fn config() -> WorldModelConfig {
        WorldModelConfig {
            enabled: true,
            daily_proactive_budget: 10,
            ..Default::default()
        }
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect()
    }

    #[test]
    fn the_retry_backoff_doubles_and_is_clamped_to_the_eighth_power() {
        assert_eq!(
            calculate_retry_at("2026-10-10T10:00:00.000Z", 0),
            "2026-10-10T10:01:00.000Z"
        );
        assert_eq!(
            calculate_retry_at("2026-10-10T10:00:00.000Z", 1),
            "2026-10-10T10:02:00.000Z"
        );
        // `2 ** min(attempts, 8)` * 60s is 4h16m — the `Math.min(6h, …)` cap of
        // `:190` is therefore unreachable, exactly like in the source.
        assert_eq!(
            calculate_retry_at("2026-10-10T10:00:00.000Z", 8),
            "2026-10-10T14:16:00.000Z"
        );
        assert_eq!(
            calculate_retry_at("2026-10-10T10:00:00.000Z", 40),
            "2026-10-10T14:16:00.000Z"
        );
    }

    #[test]
    fn a_due_loop_is_enqueued_and_its_lease_released() {
        let executor = RecordingExecutor::new(vec![
            Ok(loop_row("l1", "open")),
            Ok(count_row("0")),
            Ok(loop_row("l1", "open")),
            Ok(outbox_row()),
            Ok(PgQueryResult::empty()),
        ]);
        let result = drive_sync(deliver_due_open_loops(
            &executor,
            Some(&WorldModelScope::new("u1", "p1", None)),
            &config(),
            "u1",
            "p1",
            "",
            "2026-10-10T10:00:00.000Z",
            None,
        ))
        .expect("bridge")
        .expect("delivery");
        assert_eq!(result.total_due, 1);
        assert_eq!(result.enqueued, 1);
        assert_eq!(result.delivered, 0);
        assert!(result.reasons.is_empty());
        assert!(sqls(&executor)
            .iter()
            .any(|sql| sql
                == crate::world_model::repositories::outbox_repository::SQL_ENQUEUE_OUTBOX));
        assert!(
            !sqls(&executor)
                .iter()
                .any(|sql| sql.contains("attempts = attempts + 1")),
            "without a direct deliverer the loop is not marked as asked"
        );
    }

    #[test]
    fn an_exhausted_budget_rejects_the_loop_before_the_outbox() {
        let executor = RecordingExecutor::new(vec![
            Ok(loop_row("l1", "open")),
            Ok(count_row("5")),
            Ok(loop_row("l1", "open")),
            Ok(PgQueryResult::empty()),
        ]);
        let config = WorldModelConfig {
            daily_proactive_budget: 5,
            ..config()
        };
        let result = drive_sync(deliver_due_open_loops(
            &executor,
            None,
            &config,
            "u1",
            "p1",
            "",
            "2026-10-10T10:00:00.000Z",
            None,
        ))
        .expect("bridge")
        .expect("delivery");
        assert_eq!(result.rejected, 1);
        assert_eq!(result.reasons.get("budget_exceeded"), Some(&1));
        assert!(!sqls(&executor)
            .iter()
            .any(|sql| sql
                == crate::world_model::repositories::outbox_repository::SQL_ENQUEUE_OUTBOX));
        assert!(sqls(&executor)
            .iter()
            .any(|sql| sql.contains("locked_by = NULL")));
    }

    #[test]
    fn an_injected_deliverer_delivers_and_marks_the_loop_asked() {
        let executor = RecordingExecutor::new(vec![
            Ok(loop_row("l1", "open")),
            Ok(count_row("0")),
            Ok(loop_row("l1", "open")),
            Ok(outbox_row()),
            Ok(PgQueryResult::empty()),
        ]);
        let deliverer = |_loop: OpenLoopRecord| -> BoxFuture<'static, ChannelDeliveryResult> {
            Box::pin(async {
                ChannelDeliveryResult {
                    ok: true,
                    provider_message_id: Some("pm1".to_string()),
                }
            })
        };
        let result = drive_sync(deliver_due_open_loops(
            &executor,
            None,
            &config(),
            "u1",
            "p1",
            "",
            "2026-10-10T10:00:00.000Z",
            Some(&deliverer),
        ))
        .expect("bridge")
        .expect("delivery");
        assert_eq!(result.delivered, 1);
        assert_eq!(result.enqueued, 0);
        assert!(sqls(&executor)
            .iter()
            .any(|sql| sql.contains("attempts = attempts + 1")));
    }
}
