//! The S6 bridge seam of the Master runtime: `bridgeMasterAction` and
//! `runCanonicalMasterAction` (`toolRunner.ts:29-68`) over the core
//! `world_model::services::master_action_bridge`, with the idempotency ledger of
//! `actionLedger.ts` around each effect.
//!
//! The bridge is async and runs an action once. With the World Model off, the core
//! runs it directly. With it on, the executor decides. The default
//! [`UnconfiguredPgExecutor`] fails every call, so the action is blocked rather than
//! run without its World Model mirror.
//!
//! The core ledger port is synchronous, so [`ledger_once`] reads a committed row
//! first, then awaits the effect, then records the result. A failed effect writes no
//! row, so a retry runs it again, as the TypeScript does with a row left at `started`.

use std::future::Future;
use std::sync::Arc;

use betaclaw_core::master::execution::action_ledger::MasterActionLedgerService;
use betaclaw_core::master::execution::idempotency::build_idempotency_key;
use betaclaw_core::master::orchestrator::{
    ActionLedgerPort, BuildIdempotencyKeyInput, ExecuteExactlyOnceInput,
};
use betaclaw_core::master::repository::MasterRepository;
use betaclaw_core::master::types::WorkspaceScope;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::db::{PgExecutor, UnconfiguredPgExecutor};
use betaclaw_core::world_model::services::master_action_bridge::{
    bridge_master_action, MasterActionBridgeInput, MasterActionBridgeResult, MasterActionRunOutput,
};
use serde_json::Value;

/// The bridge configuration and the executor behind it.
pub struct ActionBridge {
    config: WorldModelConfig,
    executor: Arc<dyn PgExecutor>,
}

/// One ledgered effect: the repository it is recorded in and its identity.
pub struct LedgeredAction<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action_type: &'a str,
    pub idempotency_key: &'a str,
}

/// `buildIdempotencyKey` — `idempotency.ts:3-11`.
pub fn ledger_key(run_id: &str, step_id: &str, action_type: &str, payload: &str) -> String {
    build_idempotency_key(&BuildIdempotencyKeyInput {
        run_id,
        step_id,
        action_type,
        action_payload: payload,
    })
}

impl ActionBridge {
    /// The World Model is off, so every action runs directly.
    pub fn direct() -> Self {
        Self {
            config: WorldModelConfig::default(),
            executor: Arc::new(UnconfiguredPgExecutor),
        }
    }

    pub fn new(config: WorldModelConfig, executor: Arc<dyn PgExecutor>) -> Self {
        Self { config, executor }
    }

    /// `bridgeMasterAction(input)`: runs `run` once for this idempotency key and
    /// mirrors the attempt. An `Err` is a bridge failure, not a failed action.
    pub async fn run<Fut>(
        &self,
        input: &MasterActionBridgeInput,
        run: impl FnOnce() -> Fut,
    ) -> Result<MasterActionBridgeResult<Value>, String>
    where
        Fut: Future<Output = MasterActionRunOutput<Value>>,
    {
        bridge_master_action(&*self.executor, &self.config, input, run)
            .await
            .map_err(|error| error.into_message())
    }

    /// `runCanonicalMasterAction` — `toolRunner.ts:29-68`: one ledgered effect inside
    /// the bridge. A failed effect is an `Err` with its message, and so is a `null`
    /// result, which has nothing to report.
    pub async fn run_ledgered(
        &self,
        action: &LedgeredAction<'_>,
        input: &MasterActionBridgeInput,
        fallback: &str,
        effect: impl Future<Output = Result<Value, String>>,
    ) -> Result<Value, String> {
        let bridged = self
            .run(input, || async {
                match ledger_once(action, effect).await {
                    Ok(value) => MasterActionRunOutput {
                        ok: true,
                        error: None,
                        result: value,
                        receipt: None,
                    },
                    Err(error) => MasterActionRunOutput {
                        ok: false,
                        error: Some(error),
                        result: Value::Null,
                        receipt: None,
                    },
                }
            })
            .await?;
        settle(bridged, fallback)
    }
}

/// `executeExactlyOnce` for an awaited effect: a committed key answers from the
/// ledger; otherwise the effect runs once and its result is recorded.
pub async fn ledger_once(
    action: &LedgeredAction<'_>,
    effect: impl Future<Output = Result<Value, String>>,
) -> Result<Value, String> {
    if let Some(value) = committed_result(action) {
        return Ok(value);
    }
    let value = effect.await?;
    Ok(record(action, value))
}

/// The stored result of a committed ledger row. A row without a payload, or one that
/// does not parse, is not a replay.
fn committed_result(action: &LedgeredAction<'_>) -> Option<Value> {
    let entry = action
        .repo
        .get_action_ledger_by_key(action.scope, action.idempotency_key)
        .ok()
        .flatten()?;
    if entry.state != "committed" {
        return None;
    }
    serde_json::from_str(entry.result_payload.as_deref()?).ok()
}

/// Records a fresh result and returns what the ledger then holds.
fn record(action: &LedgeredAction<'_>, value: Value) -> Value {
    MasterActionLedgerService::new(action.repo)
        .execute_exactly_once(ExecuteExactlyOnceInput {
            scope: action.scope,
            run_id: action.run_id,
            step_id: action.step_id,
            action_type: action.action_type,
            idempotency_key: action.idempotency_key,
            execute: Box::new(move || value),
        })
        .result
}

/// The bridge outcome as the `runCanonicalMasterAction` result.
fn settle(bridged: MasterActionBridgeResult<Value>, fallback: &str) -> Result<Value, String> {
    if !bridged.succeeded {
        return Err(bridged.error.unwrap_or_else(|| fallback.to_string()));
    }
    match bridged.result {
        None | Some(Value::Null) => Err(fallback.to_string()),
        Some(value) => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::Arc;

    use betaclaw_core::world_model::config::WorldModelConfig;
    use betaclaw_core::world_model::db::{drive_sync, UnconfiguredPgExecutor};
    use betaclaw_core::world_model::services::master_action_bridge::{
        MasterActionBridgeInput, MasterActionRunOutput,
    };
    use serde_json::{json, Value};

    use super::ActionBridge;

    fn input() -> MasterActionBridgeInput {
        MasterActionBridgeInput {
            user_id: "u1".to_string(),
            persona_id: Some("p1".to_string()),
            workspace_id: Some("w1".to_string()),
            task_id: "run-1".to_string(),
            action_type: "notes".to_string(),
            idempotency_key: "run-1:step-1:notes:abc".to_string(),
            correlation_id: Some("run-1".to_string()),
        }
    }

    #[test]
    fn with_the_world_model_off_the_action_runs_directly() {
        let bridge = ActionBridge::direct();
        let ran = Cell::new(false);
        let result = drive_sync(bridge.run(&input(), || async {
            ran.set(true);
            MasterActionRunOutput {
                ok: true,
                error: None,
                result: json!({ "id": "note-1" }),
                receipt: None,
            }
        }))
        .expect("runtime")
        .expect("bridge runs");
        assert!(ran.get());
        assert!(result.succeeded);
        assert_eq!(result.result, Some(json!({ "id": "note-1" })));
        assert_eq!(result.attempt_id, "direct-run-1:step-1:notes:abc");
    }

    #[test]
    fn a_failed_action_reports_its_error() {
        let bridge = ActionBridge::direct();
        let result = drive_sync(bridge.run(&input(), || async {
            MasterActionRunOutput::<Value> {
                ok: false,
                error: Some("disk full".to_string()),
                result: Value::Null,
                receipt: None,
            }
        }))
        .expect("runtime")
        .expect("bridge runs");
        assert!(!result.succeeded);
        assert_eq!(result.error.as_deref(), Some("disk full"));
    }

    #[test]
    fn an_enabled_world_model_without_an_executor_does_not_run_the_action() {
        let config = WorldModelConfig {
            enabled: true,
            ..WorldModelConfig::default()
        };
        let bridge = ActionBridge::new(config, Arc::new(UnconfiguredPgExecutor));
        let ran = Cell::new(false);
        let outcome = drive_sync(bridge.run(&input(), || async {
            ran.set(true);
            MasterActionRunOutput {
                ok: true,
                error: None,
                result: Value::Null,
                receipt: None,
            }
        }))
        .expect("runtime");
        assert!(!ran.get(), "the action must not run unmirrored");
        if let Ok(result) = outcome {
            assert!(!result.succeeded);
        }
    }
}
