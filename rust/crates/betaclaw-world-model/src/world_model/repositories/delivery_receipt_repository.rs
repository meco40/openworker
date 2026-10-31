//! Port of `src/server/world-model/repositories/deliveryReceiptRepository.ts`
//! (166 lines) — the receipt of a delivered proactive message.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `deliveryReceiptRepository.ts:3-15` (`DeliveryReceiptInput`) | [`DeliveryReceiptInput`] |
//! | `deliveryReceiptRepository.ts:17-20` (`DeliveryReceiptRecord`) | [`DeliveryReceiptRecord`] |
//! | `deliveryReceiptRepository.ts:22-81` (`insertDeliveryReceipt`) | [`insert_delivery_receipt`] |
//! | `deliveryReceiptRepository.ts:83-123` (`getDeliveryReceiptByOutboxEventId`) | [`get_delivery_receipt_by_outbox_event_id`] |
//! | `deliveryReceiptRepository.ts:125-166` (`getLatestDeliveryReceiptByOpenLoopId`) | [`get_latest_delivery_receipt_by_open_loop_id`] |
//! | `deliveryReceiptRepository.ts:40-50` (insert) | [`SQL_INSERT_RECEIPT`] |
//! | `deliveryReceiptRepository.ts:101-103` (by event) | [`SQL_RECEIPT_BY_EVENT`] |
//! | `deliveryReceiptRepository.ts:143-146` (latest by loop) | [`SQL_LATEST_RECEIPT_BY_LOOP`] |
//! | `deliveryReceiptRepository.ts:66-80`, `:108-122`, `:151-165` (three identical row mappings) | [`to_receipt`] |
//!
//! The source spells the same row mapping out three times and keeps the
//! `delivered_at` handling (`instanceof Date ? toISOString() : value`) three
//! times as well; the port keeps one [`to_receipt`], so the three statements
//! cannot drift apart. The behaviour is unchanged: the driver hands a
//! `timestamptz` column over as the ISO text `Date#toISOString()` would produce
//! (`driver.rs`, "Row decoding"), and `pg` only ever produced a `Date` from a
//! `timestamp` column, which the canonical schema does not use for
//! `delivered_at`.
//!
//! # Deviations
//!
//! 1. **A missing `RETURNING` row is an error instead of a `TypeError`.** The
//!    source reads `result.rows[0]!` (`:65`); the port answers
//!    [`MISSING_RECEIPT_ROW`].

use serde_json::{Map, Value};

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_object, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;

/// `DeliveryReceiptInput` from `deliveryReceiptRepository.ts:3-15`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryReceiptInput {
    pub outbox_event_id: String,
    pub open_loop_id: Option<String>,
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — `input.workspaceId ?? ''`.
    pub workspace_id: Option<String>,
    pub channel: String,
    pub target: String,
    pub provider_id: Option<String>,
    pub provider_message_id: Option<String>,
    /// `deliveredAt?: string` — bound to `COALESCE($10, now())`.
    pub delivered_at: Option<String>,
    /// `payload?: Record<string, unknown>` — `JSON.stringify(payload ?? {})`.
    pub payload: Option<Map<String, Value>>,
}

/// `DeliveryReceiptRecord extends DeliveryReceiptInput`
/// (`deliveryReceiptRepository.ts:17-20`).
///
/// The record's `deliveredAt` is required, which is why it is not reused from
/// the input struct: the `delivered_at` column is what the `COALESCE` resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryReceiptRecord {
    pub id: String,
    pub outbox_event_id: String,
    pub open_loop_id: Option<String>,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub channel: String,
    pub target: String,
    pub provider_id: Option<String>,
    pub provider_message_id: Option<String>,
    pub delivered_at: String,
    pub payload: Map<String, Value>,
}

/// `deliveryReceiptRepository.ts:40-50`.
pub const SQL_INSERT_RECEIPT: &str = "INSERT INTO world_model_delivery_receipts\n  (outbox_event_id, open_loop_id, user_id, persona_id, workspace_id, channel, target,\n   provider_id, provider_message_id, delivered_at, payload)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()),$11)\nON CONFLICT (outbox_event_id) DO UPDATE SET\n  provider_id = EXCLUDED.provider_id,\n  provider_message_id = EXCLUDED.provider_message_id,\n  delivered_at = EXCLUDED.delivered_at,\n  payload = EXCLUDED.payload\nRETURNING id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,\n          channel, target, provider_id, provider_message_id, delivered_at, payload";

/// `deliveryReceiptRepository.ts:101-103`.
pub const SQL_RECEIPT_BY_EVENT: &str = "SELECT id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,\n       channel, target, provider_id, provider_message_id, delivered_at, payload\nFROM world_model_delivery_receipts WHERE outbox_event_id = $1";

/// `deliveryReceiptRepository.ts:143-146`.
pub const SQL_LATEST_RECEIPT_BY_LOOP: &str = "SELECT id, outbox_event_id, open_loop_id, user_id, persona_id, workspace_id,\n       channel, target, provider_id, provider_message_id, delivered_at, payload\nFROM world_model_delivery_receipts\nWHERE open_loop_id = $1 ORDER BY delivered_at DESC LIMIT 1";

/// The port's answer for `result.rows[0]!` (`:65`) — deviation 1.
pub const MISSING_RECEIPT_ROW: &str = "[world-model] delivery receipt insert returned no row";

/// The row mapping of `deliveryReceiptRepository.ts:66-80`, `:108-122`, `:151-165`.
fn to_receipt(row: &PgRow) -> DeliveryReceiptRecord {
    DeliveryReceiptRecord {
        id: row_text(row, "id"),
        outbox_event_id: row_text(row, "outbox_event_id"),
        open_loop_id: row_optional_text(row, "open_loop_id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        channel: row_text(row, "channel"),
        target: row_text(row, "target"),
        provider_id: row_optional_text(row, "provider_id"),
        provider_message_id: row_optional_text(row, "provider_message_id"),
        delivered_at: row_text(row, "delivered_at"),
        payload: row_object(row, "payload"),
    }
}

/// `insertDeliveryReceipt(input, db)` — `deliveryReceiptRepository.ts:22-81`.
///
/// `ON CONFLICT (outbox_event_id) DO UPDATE` makes the receipt idempotent per
/// event: a redelivery refreshes provider id, message id, timestamp and payload.
pub async fn insert_delivery_receipt<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &DeliveryReceiptInput,
) -> Result<DeliveryReceiptRecord, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_RECEIPT,
            vec![
                PgValue::text(input.outbox_event_id.as_str()),
                PgValue::nullable_text(input.open_loop_id.clone()),
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.clone().unwrap_or_default()),
                PgValue::text(input.channel.as_str()),
                PgValue::text(input.target.as_str()),
                PgValue::nullable_text(input.provider_id.clone()),
                PgValue::nullable_text(input.provider_message_id.clone()),
                PgValue::nullable_text(input.delivered_at.clone()),
                PgValue::text(Value::Object(input.payload.clone().unwrap_or_default()).to_string()),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_receipt(row)),
        None => Err(E::from(PgError::new(MISSING_RECEIPT_ROW))),
    }
}

/// `getDeliveryReceiptByOutboxEventId(outboxEventId, db)` —
/// `deliveryReceiptRepository.ts:83-123`.
pub async fn get_delivery_receipt_by_outbox_event_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    outbox_event_id: &str,
) -> Result<Option<DeliveryReceiptRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_RECEIPT_BY_EVENT, vec![PgValue::text(outbox_event_id)]),
    )
    .await?;
    Ok(result.first().map(to_receipt))
}

/// `getLatestDeliveryReceiptByOpenLoopId(openLoopId, db)` —
/// `deliveryReceiptRepository.ts:125-166`.
pub async fn get_latest_delivery_receipt_by_open_loop_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    open_loop_id: &str,
) -> Result<Option<DeliveryReceiptRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_LATEST_RECEIPT_BY_LOOP,
            vec![PgValue::text(open_loop_id)],
        ),
    )
    .await?;
    Ok(result.first().map(to_receipt))
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

    fn input() -> DeliveryReceiptInput {
        DeliveryReceiptInput {
            outbox_event_id: "e1".to_string(),
            open_loop_id: Some("l1".to_string()),
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: None,
            channel: "whatsapp".to_string(),
            target: "+49".to_string(),
            provider_id: None,
            provider_message_id: Some("m1".to_string()),
            delivered_at: None,
            payload: None,
        }
    }

    fn receipt_row() -> PgRow {
        json!({
            "id": "r1",
            "outbox_event_id": "e1",
            "open_loop_id": "l1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "",
            "channel": "whatsapp",
            "target": "+49",
            "provider_id": null,
            "provider_message_id": "m1",
            "delivered_at": "2026-10-10T10:00:05.000Z",
            "payload": { "question": "Confirm?" },
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect()
    }

    #[test]
    fn an_insert_runs_scoped_and_binds_the_soft_defaults() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![receipt_row()]))]);
        let receipt = drive_sync(insert_delivery_receipt::<PgError>(
            &executor,
            Some(&scope()),
            &input(),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(receipt.id, "r1");
        assert_eq!(receipt.delivered_at, "2026-10-10T10:00:05.000Z");
        assert_eq!(receipt.payload["question"], json!("Confirm?"));
        assert_eq!(receipt.provider_id, None);
        assert_eq!(
            sqls(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_RECEIPT.to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("e1"),
                    PgValue::text("l1"),
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("whatsapp"),
                    PgValue::text("+49"),
                    PgValue::Null,
                    PgValue::text("m1"),
                    PgValue::Null,
                    PgValue::text("{}"),
                ],
                "`openLoopId ?? null`, `workspaceId ?? ''`, `deliveredAt ?? null`, \
                 `JSON.stringify(payload ?? {{}})`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_returning_row_is_an_error() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let error = drive_sync(insert_delivery_receipt::<PgError>(
            &executor,
            None,
            &input(),
        ))
        .expect("bridge")
        .expect_err("no row");
        assert_eq!(error.message, MISSING_RECEIPT_ROW);
    }

    #[test]
    fn the_two_reads_answer_none_without_a_row_and_bind_their_key() {
        let by_event = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let found = drive_sync(get_delivery_receipt_by_outbox_event_id::<PgError>(
            &by_event, None, "e1",
        ))
        .expect("bridge")
        .expect("read");
        assert!(found.is_none());
        assert_eq!(
            sqls(&by_event),
            vec![SQL_RECEIPT_BY_EVENT.to_string()],
            "unscoped: no BEGIN, no scope, no COMMIT"
        );
        match &by_event.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params, vec![PgValue::text("e1")]);
            }
            other => panic!("expected the event read, got {other:?}"),
        }

        let by_loop =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![receipt_row()]))]);
        let found = drive_sync(get_latest_delivery_receipt_by_open_loop_id::<PgError>(
            &by_loop,
            Some(&scope()),
            "l1",
        ))
        .expect("bridge")
        .expect("read");
        assert_eq!(found.map(|receipt| receipt.id), Some("r1".to_string()));
        assert_eq!(
            sqls(&by_loop),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_LATEST_RECEIPT_BY_LOOP.to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &by_loop.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params, vec![PgValue::text("l1")]);
            }
            other => panic!("expected the loop read, got {other:?}"),
        }
    }
}
