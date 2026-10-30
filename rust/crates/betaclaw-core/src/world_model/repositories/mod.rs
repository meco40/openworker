//! Port of `src/server/world-model/repositories/`.
//!
//! One module per TypeScript file; the submodules are declared by the work
//! package that ports them, so this file lists exactly what exists.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`action_attempt_repository`] | `actionAttemptRepository.ts` |
//! | [`assertion_repository`] | `assertionRepository.ts` |
//! | [`delivery_receipt_repository`] | `deliveryReceiptRepository.ts` |
//! | [`entity_repository`] | `entityRepository.ts` |
//! | [`event_repository`] | `eventRepository.ts` |
//! | [`ingestion_checkpoint_repository`] | `ingestionCheckpointRepository.ts` |
//! | [`observation_repository`] | `observationRepository.ts` |
//! | [`outbox_repository`] | `outboxRepository.ts` |
//! | [`projection_pending_repository`] | `projectionPendingRepository.ts` |
//! | [`prospective_repository`] | `prospectiveRepository.ts` |
//! | [`task_repository`] | `taskRepository.ts` |
//!
//! # The ambient scope of `getWorldModelDb()`
//!
//! `db.ts:100-112` decides **per statement** whether it runs scoped: inside
//! `runWithWorldModelScope` the returned `query` is `queryWithScope`
//! (`db.ts:62-85`) — `BEGIN` → `world_model_set_scope($1,$2,$3)` → statement →
//! `COMMIT` on its own connection — while outside it is a bare
//! `pool.query(text, values)` (`db.ts:109`). `withWorldModelTransaction`
//! (`db.ts:204-229`) makes the same decision for a block: it sets the scope when
//! one is active (`:213`) and otherwise only wraps `BEGIN`/`COMMIT` (`:228`).
//!
//! `AsyncLocalStorage` (`db.ts:11`) has no Rust counterpart, so every ported
//! repository takes the *ambient* scope as `Option<&WorldModelScope>`:
//!
//! * `Some(scope)` — the caller runs inside `runWithWorldModelScope`, so the
//!   statement goes through `scoped_query` and the block through `run_scoped`
//!   with the tenant triple.
//! * `None` — no scope is active, so the statement is the bare `pool.query`:
//!   **no** `BEGIN`, **no** scope call, and the RLS policies see an unscoped
//!   session (`006_rls_and_runtime_roles.sql:86`, `:106`). The outbox dispatcher
//!   (`outboxDispatcher.ts:60-78`), the heartbeat scan
//!   (`heartbeatRuntime.ts:25`), the runtime scope discovery
//!   (`scopeDiscovery.ts:54-58`) and the integration tests take exactly this
//!   path in the TypeScript.
//!
//! [`ambient_query`] and [`ambient_transaction`] are that decision, written once
//! for all eleven modules instead of eleven times. They add no behaviour of
//! their own: the first is `getWorldModelDb().query` (`db.ts:107-110`) and the
//! second is `withWorldModelTransaction(callback, scope?)` (`db.ts:204-229`).
//!
//! # Row access
//!
//! [`row_text`], [`row_optional_text`], [`row_number`], [`row_integer`],
//! [`row_object`] and [`row_boolean`] read a [`PgRow`] the way the TypeScript
//! reads a `pg` row: by column name, with the coercions the source spells out
//! (`Number(row.last_seq)`, `row.payload ?? {}`,
//! `row.error_message ?? undefined`). They exist for the same reason as the two
//! wrappers above — the eleven row contracts differ, the reading does not.

pub mod action_attempt_repository;
pub mod assertion_repository;
pub mod delivery_receipt_repository;
pub mod entity_repository;
pub mod event_repository;
pub mod ingestion_checkpoint_repository;
pub mod observation_repository;
pub mod outbox_repository;
pub mod projection_pending_repository;
pub mod prospective_repository;
pub mod task_repository;

use serde_json::{Map, Value};

use crate::js::js_number_str;
use crate::world_model::db::{
    run_scoped, scoped_query, NormalizedScope, PgError, PgExecutor, PgQueryResult, PgRow,
    PgStatement, ScopedBody,
};
use crate::world_model::scope::WorldModelScope;

/// `normalizedScope(scope)` — `db.ts:30-36`.
///
/// The `Required<WorldModelScope>` shape (`workspaceId ?? ''`) that every
/// `scoped_query`, `run_scoped` and `set_database_scope` takes. The foundation
/// models the same triple twice — [`ScopeParts`](crate::world_model::scope::ScopeParts)
/// in `scope.rs` and [`NormalizedScope`] in `db.rs` — without a conversion, so
/// this adapter is the one place the eleven modules cross from one to the other.
pub fn normalized_scope(scope: &WorldModelScope) -> NormalizedScope {
    let parts = scope.parts();
    NormalizedScope {
        user_id: parts.user_id,
        persona_id: parts.persona_id,
        workspace_id: parts.workspace_id,
    }
}

/// `getWorldModelDb().query(text, values)` — `db.ts:107-110`.
///
/// The scoped branch is `queryWithScope` (`db.ts:62-85`,
/// [`scoped_query`](crate::world_model::db::scoped_query)), the unscoped one is
/// `pool.query` ([`PgExecutor::query`]). The error type stays the caller's, like
/// `scoped_query` and `run_scoped` in [`crate::world_model::db`].
pub async fn ambient_query<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    statement: PgStatement,
) -> Result<PgQueryResult, E> {
    match scope {
        Some(scope) => scoped_query::<E>(executor, &normalized_scope(scope), statement).await,
        None => executor.query(statement).await.map_err(E::from),
    }
}

/// `withWorldModelTransaction(callback, scope)` — `db.ts:204-229`.
///
/// `activeScope = scope ?? getWorldModelScope()` (`:208`): with a scope the
/// transaction sets the tenant triple, without one it only runs
/// `BEGIN` → work → `COMMIT` (`:228`).
pub async fn ambient_transaction<T: Send + 'static, E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    body: ScopedBody<T, E>,
) -> Result<T, E> {
    let parts = scope.map(normalized_scope);
    run_scoped(executor, parts.as_ref(), body).await
}

// ─── Row access ─────────────────────────────────────────────────────────────

/// `row.<column>` of a `text`/`uuid`/`timestamptz` column.
///
/// A missing or `NULL` column is `''`; the column contracts of the ported tables
/// are `NOT NULL` (`001_world_model.sql`), so the coercion is the `?? ''` /
/// `String(undefined)` fallback of the source and not a silent replacement.
pub fn row_text(row: &PgRow, column: &str) -> String {
    match row.get(column) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// `row.<column> ?? undefined` for an optional column.
pub fn row_optional_text(row: &PgRow, column: &str) -> Option<String> {
    match row.get(column) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `Number(row.<column>)`.
///
/// `pg` hands an `int8` over as text, so the numeric string form parses here —
/// `Number('5')` is `5` and `Number('')` is `0`, which is what
/// [`js_number_str`](crate::js::js_number_str) reproduces. `NULL` is
/// `Number(null)` = `0`, an absent column `Number(undefined)` = `NaN`.
pub fn row_number(row: &PgRow, column: &str) -> f64 {
    match row.get(column) {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_number_str(text),
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Null) => 0.0,
        None => f64::NAN,
        Some(_) => f64::NAN,
    }
}

/// `Number(row.<column>)` truncated into the integer field of a record.
///
/// The source stores `attempts`, `last_seq` and `fire_count` as JavaScript
/// numbers; the records are integral, and a `NaN` cannot become an `i64`, so an
/// unreadable column becomes `0` instead of poisoning the record.
pub fn row_integer(row: &PgRow, column: &str) -> i64 {
    let number = row_number(row, column);
    if number.is_finite() {
        number.trunc() as i64
    } else {
        0
    }
}

/// `(row.<column> ?? {}) as Record<string, unknown>` for a `jsonb` column.
///
/// The driver parses `jsonb` into a [`Value`], so an object is the stored value
/// and `null` the empty bag the source spreads.
pub fn row_object(row: &PgRow, column: &str) -> Map<String, Value> {
    match row.get(column) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// A `boolean` / `boolean | null` column, e.g. `(xmax = 0) AS inserted`
/// (`outboxRepository.ts:57`).
pub fn row_boolean(row: &PgRow, column: &str) -> Option<bool> {
    match row.get(column) {
        Some(Value::Bool(flag)) => Some(*flag),
        _ => None,
    }
}
