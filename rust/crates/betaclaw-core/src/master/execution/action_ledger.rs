//! Port of `src/server/master/execution/actionLedger.ts:1-57`.
//!
//! [`MasterActionLedgerService`] implements the
//! [`ActionLedgerPort`](crate::master::orchestrator::ActionLedgerPort) seam that
//! the orchestrator already declared. One idempotency key runs its side effect at
//! most once: a `committed` row with a stored payload replays, otherwise the row
//! is marked `started`, the effect runs and the row becomes `committed`.
//!
//! # The port returns an outcome, so a repository error cannot unwind
//!
//! `executeExactlyOnce` is `async` and a repository failure rejects the promise;
//! the seam's `execute_exactly_once` returns `ExecuteExactlyOnceOutcome` and so
//! cannot. The port therefore logs a repository failure and continues best
//! effort, and a stored payload that no longer parses re-runs the effect instead
//! of rejecting — both recorded as OP-S9-12.
//!
//! # A `null` result is stored as SQL `NULL`
//!
//! `JSON.stringify(undefined)` is `undefined`, which the store writes as `NULL`
//! (`governance.store.ts`). A [`Value::Null`] result is stored as `None` for the
//! same reason, so the source's `existing.resultPayload` truthiness check keeps
//! the same answer.

use std::future::Future;

use serde_json::Value;

use crate::master::orchestrator::{
    ActionLedgerPort, BuildIdempotencyKeyInput, ExecuteExactlyOnceInput, ExecuteExactlyOnceOutcome,
};
use crate::master::repository::governance_store::MasterActionLedgerInput;
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

use super::idempotency::build_idempotency_key;

/// `MasterActionLedgerService` from `actionLedger.ts:4-57`.
pub struct MasterActionLedgerService<'a> {
    repo: &'a dyn MasterRepository,
}

impl<'a> MasterActionLedgerService<'a> {
    /// `constructor(private readonly repo)` — `actionLedger.ts:5`.
    pub fn new(repo: &'a dyn MasterRepository) -> Self {
        Self { repo }
    }

    /// `executeExactlyOnce` with an awaited `execute` — `actionLedger.ts:7-56`.
    ///
    /// The Gmail send and the Master tools are async, so their effect cannot
    /// run inside the sync [`ActionLedgerPort`] seam. The row handling is the
    /// same as there. A failing `execute` returns `Err` and leaves the
    /// `started` row in place, as the rejected promise does in the source.
    pub async fn execute_exactly_once_async<E, Fut>(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        step_id: &str,
        action_type: &str,
        idempotency_key: &str,
        execute: impl FnOnce() -> Fut,
    ) -> Result<ExecuteExactlyOnceOutcome, E>
    where
        Fut: Future<Output = Result<Value, E>>,
    {
        let row = LedgerRow {
            scope,
            run_id,
            step_id,
            action_type,
            idempotency_key,
        };
        if let Some(result) = row.replay(self.repo) {
            return Ok(ExecuteExactlyOnceOutcome {
                replayed: true,
                result,
            });
        }
        row.write(self.repo, "started", None);
        let result = execute().await?;
        row.write(self.repo, "committed", payload_of(&result));
        Ok(ExecuteExactlyOnceOutcome {
            replayed: false,
            result,
        })
    }
}

/// The scope and keys of one ledger row, shared by the sync and async paths.
struct LedgerRow<'x> {
    scope: &'x WorkspaceScope,
    run_id: &'x str,
    step_id: &'x str,
    action_type: &'x str,
    idempotency_key: &'x str,
}

impl LedgerRow<'_> {
    /// The stored result of a `committed` row with a parseable payload.
    fn replay(&self, repo: &dyn MasterRepository) -> Option<Value> {
        let entry = repo
            .get_action_ledger_by_key(self.scope, self.idempotency_key)
            .ok()
            .flatten()?;
        if entry.state != "committed" {
            return None;
        }
        serde_json::from_str::<Value>(entry.result_payload.as_deref()?).ok()
    }

    /// The repository write. A failure is logged and does not unwind (OP-S9-12).
    fn write(&self, repo: &dyn MasterRepository, state: &str, result_payload: Option<String>) {
        let written = repo.upsert_action_ledger(
            self.scope,
            &MasterActionLedgerInput {
                run_id: self.run_id.to_string(),
                step_id: self.step_id.to_string(),
                action_type: self.action_type.to_string(),
                idempotency_key: self.idempotency_key.to_string(),
                state: state.to_string(),
                result_payload,
            },
        );
        if let Err(error) = written {
            tracing::warn!(%error, state, "master action ledger write failed");
        }
    }
}

/// `JSON.stringify(undefined)` is `undefined`, so a `null` result is stored as
/// SQL `NULL` (see the module header).
fn payload_of(result: &Value) -> Option<String> {
    if result.is_null() {
        None
    } else {
        Some(result.to_string())
    }
}

impl ActionLedgerPort for MasterActionLedgerService<'_> {
    /// `buildIdempotencyKey` — `idempotency.ts:3-11`.
    fn build_idempotency_key(&self, input: &BuildIdempotencyKeyInput<'_>) -> String {
        build_idempotency_key(input)
    }

    /// `executeExactlyOnce` — `actionLedger.ts:7-56`.
    fn execute_exactly_once(
        &self,
        input: ExecuteExactlyOnceInput<'_>,
    ) -> ExecuteExactlyOnceOutcome {
        let row = LedgerRow {
            scope: input.scope,
            run_id: input.run_id,
            step_id: input.step_id,
            action_type: input.action_type,
            idempotency_key: input.idempotency_key,
        };
        if let Some(result) = row.replay(self.repo) {
            return ExecuteExactlyOnceOutcome {
                replayed: true,
                result,
            };
        }

        row.write(self.repo, "started", None);
        let result = (input.execute)();
        row.write(self.repo, "committed", payload_of(&result));
        ExecuteExactlyOnceOutcome {
            replayed: false,
            result,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::WorkspaceScope;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn input<'a>(scope: &'a WorkspaceScope, calls: &'a Cell<usize>) -> ExecuteExactlyOnceInput<'a> {
        ExecuteExactlyOnceInput {
            scope,
            run_id: "run-1",
            step_id: "step-1",
            action_type: "file.write",
            idempotency_key: "key-1",
            execute: Box::new(move || {
                calls.set(calls.get() + 1);
                serde_json::json!({ "ok": true })
            }),
        }
    }

    #[test]
    fn a_second_call_replays_the_committed_result() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let service = MasterActionLedgerService::new(&repo);
        let scope = scope();

        let first_calls = Cell::new(0);
        let first = service.execute_exactly_once(input(&scope, &first_calls));
        assert!(!first.replayed);
        assert_eq!(first.result, serde_json::json!({ "ok": true }));
        assert_eq!(first_calls.get(), 1);

        let second_calls = Cell::new(0);
        let second = service.execute_exactly_once(input(&scope, &second_calls));
        assert!(second.replayed);
        assert_eq!(second.result, serde_json::json!({ "ok": true }));
        assert_eq!(second_calls.get(), 0, "the effect must not run twice");
    }

    #[test]
    fn a_null_result_is_not_replayed() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let service = MasterActionLedgerService::new(&repo);
        let scope = scope();

        fn make<'a>(
            scope: &'a WorkspaceScope,
            calls: &'a Cell<usize>,
        ) -> ExecuteExactlyOnceInput<'a> {
            ExecuteExactlyOnceInput {
                scope,
                run_id: "run-1",
                step_id: "step-1",
                action_type: "noop",
                idempotency_key: "key-null",
                execute: Box::new(move || {
                    calls.set(calls.get() + 1);
                    Value::Null
                }),
            }
        }

        let first_calls = Cell::new(0);
        assert!(
            !service
                .execute_exactly_once(make(&scope, &first_calls))
                .replayed
        );
        let second_calls = Cell::new(0);
        assert!(
            !service
                .execute_exactly_once(make(&scope, &second_calls))
                .replayed
        );
        assert_eq!(second_calls.get(), 1);
    }

    #[test]
    fn the_key_matches_the_idempotency_module() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let service = MasterActionLedgerService::new(&repo);
        let input = BuildIdempotencyKeyInput {
            run_id: "run-1",
            step_id: "step-1",
            action_type: "file.write",
            action_payload: "abc",
        };
        assert_eq!(
            service.build_idempotency_key(&input),
            build_idempotency_key(&input)
        );
    }

    #[tokio::test]
    async fn a_failed_async_execute_leaves_the_started_row() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let service = MasterActionLedgerService::new(&repo);
        let scope = scope();

        let failed = service
            .execute_exactly_once_async(
                &scope,
                "run-1",
                "step-1",
                "gmail.send",
                "key-fail",
                || async { Err::<Value, &str>("boom") },
            )
            .await;
        assert_eq!(failed.err(), Some("boom"));
        let stored = repo
            .get_action_ledger_by_key(&scope, "key-fail")
            .unwrap()
            .unwrap();
        assert_eq!(stored.state, "started");

        let retried = service
            .execute_exactly_once_async(
                &scope,
                "run-1",
                "step-1",
                "gmail.send",
                "key-fail",
                || async { Ok::<Value, &str>(serde_json::json!({ "sent": true })) },
            )
            .await
            .unwrap();
        assert!(!retried.replayed);
        let stored = repo
            .get_action_ledger_by_key(&scope, "key-fail")
            .unwrap()
            .unwrap();
        assert_eq!(stored.state, "committed");
    }
}
