//! Port of `src/server/world-model/services/masterActionBridge.ts:1-104`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `masterActionBridge.ts:17-26` (`MasterActionBridgeInput`) | [`MasterActionBridgeInput`] |
//! | `masterActionBridge.ts:28-36` (`MasterActionBridgeResult`) | [`MasterActionBridgeResult`] |
//! | `masterActionBridge.ts:38-48` (`toWorldModelScope`) | [`to_world_model_scope`] |
//! | `masterActionBridge.ts:54-104` (`bridgeMasterAction`) | [`bridge_master_action`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is derived from the input.** `toWorldModelScope`
//!    (`:38-48`) has no `AsyncLocalStorage` dependency; the port keeps the literal
//!    `personaId ?? 'default'` / `workspaceId ?? ''` mapping.
//! 2. **The in-memory capture is an `Arc<Mutex<…>>`.** The source reads the
//!    `captured` variable that its `run` closure assigned (`:72`, `:81`); the port
//!    shares the same cell with the closure so a replay that never runs the side
//!    effect still reports the persisted result.
//! 3. **`getWorldModelConfig()` is a parameter** so the bridge stays deterministic.

use std::future::Future;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::action_attempt_repository::ToolActionResult;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::action_service::ActionRunResult;
use crate::world_model::services::mission_control_bridge::{
    execute_mission_control_action, MissionControlActionInput,
};

/// `MasterActionBridgeInput` from `masterActionBridge.ts:17-26` (without the
/// `run` callback, which is passed separately).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterActionBridgeInput {
    pub user_id: String,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
    pub task_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
}

/// The `{ ok, error?, result, receipt? }` the `run` callback resolves to
/// (`:25`).
#[derive(Debug, Clone, PartialEq)]
pub struct MasterActionRunOutput<T> {
    pub ok: bool,
    pub error: Option<String>,
    pub result: T,
    pub receipt: Option<ToolActionResult>,
}

/// `MasterActionBridgeResult` from `masterActionBridge.ts:28-36`.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterActionBridgeResult<T> {
    pub attempt_id: String,
    pub succeeded: bool,
    pub created: bool,
    pub error: Option<String>,
    pub replayed: bool,
    pub result: Option<T>,
    pub receipt: Option<ToolActionResult>,
}

/// `toWorldModelScope(input)` — `masterActionBridge.ts:38-48`.
pub fn to_world_model_scope(input: &MasterActionBridgeInput) -> WorldModelScope {
    WorldModelScope::new(
        &input.user_id,
        input
            .persona_id
            .clone()
            .unwrap_or_else(|| "default".to_string()),
        input.workspace_id.clone(),
    )
}

/// `persistedPayload && typeof persistedPayload === 'object' && 'result' in
/// persistedPayload ? persistedPayload.result : undefined` — `:89-93`.
pub fn extract_replayed_result<T: DeserializeOwned>(payload: Option<&Value>) -> Option<T> {
    match payload {
        Some(Value::Object(map)) if map.contains_key("result") => map
            .get("result")
            .and_then(|value| serde_json::from_value::<T>(value.clone()).ok()),
        _ => None,
    }
}

/// `bridgeMasterAction(input)` — `masterActionBridge.ts:54-104`.
pub async fn bridge_master_action<T, F, Fut>(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &MasterActionBridgeInput,
    run: F,
) -> Result<MasterActionBridgeResult<T>, PgError>
where
    T: Clone + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: Future<Output = MasterActionRunOutput<T>>,
{
    if !config.enabled && !config.e2e_enabled {
        let run_result = run().await;
        return Ok(MasterActionBridgeResult {
            attempt_id: format!("direct-{}", input.idempotency_key),
            succeeded: run_result.ok,
            created: true,
            error: run_result.error,
            replayed: false,
            result: Some(run_result.result),
            receipt: run_result.receipt,
        });
    }

    let captured: Arc<Mutex<Option<MasterActionRunOutput<T>>>> = Arc::new(Mutex::new(None));
    let captured_in = Arc::clone(&captured);
    let action_input = MissionControlActionInput {
        scope: to_world_model_scope(input),
        task_id: input.task_id.clone(),
        action_type: input.action_type.clone(),
        idempotency_key: input.idempotency_key.clone(),
        correlation_id: input.correlation_id.clone(),
    };
    let attempt = execute_mission_control_action(executor, config, &action_input, move || {
        let captured = Arc::clone(&captured_in);
        async move {
            let output = run().await;
            let action = ActionRunResult {
                ok: output.ok,
                error: output.error.clone(),
                result: output.receipt.clone(),
            };
            *captured.lock().expect("capture mutex") = Some(output);
            action
        }
    })
    .await?;

    let persisted_payload = attempt
        .result
        .as_ref()
        .and_then(|result| result.payload.as_ref());
    let replayed_result: Option<T> = extract_replayed_result(persisted_payload);
    let captured = captured.lock().expect("capture mutex").take();
    Ok(MasterActionBridgeResult {
        attempt_id: attempt.attempt_id,
        succeeded: attempt.succeeded,
        created: attempt.created,
        error: attempt
            .error
            .clone()
            .or_else(|| captured.as_ref().and_then(|output| output.error.clone())),
        replayed: !attempt.created,
        result: captured
            .as_ref()
            .map(|output| output.result.clone())
            .or(replayed_result),
        receipt: attempt
            .result
            .or_else(|| captured.and_then(|output| output.receipt)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::RecordingExecutor;
    use serde_json::json;

    fn input(persona: Option<&str>, workspace: Option<&str>) -> MasterActionBridgeInput {
        MasterActionBridgeInput {
            user_id: "u1".into(),
            persona_id: persona.map(str::to_string),
            workspace_id: workspace.map(str::to_string),
            task_id: "t1".into(),
            action_type: "send".into(),
            idempotency_key: "key1".into(),
            correlation_id: None,
        }
    }

    #[test]
    fn a_disabled_world_model_runs_the_action_directly() {
        let executor = RecordingExecutor::new(vec![]);
        let result = drive_sync(bridge_master_action(
            &executor,
            &WorldModelConfig::default(),
            &input(None, None),
            || async {
                MasterActionRunOutput {
                    ok: true,
                    error: None,
                    result: 7i32,
                    receipt: None,
                }
            },
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(result.attempt_id, "direct-key1");
        assert!(result.created);
        assert!(!result.replayed);
        assert_eq!(result.result, Some(7));
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_replayed_payload_exposes_its_result() {
        let payload = json!({ "result": "x", "providerId": "telegram" });
        assert_eq!(
            extract_replayed_result::<String>(Some(&payload)),
            Some("x".to_string())
        );
        assert_eq!(extract_replayed_result::<String>(Some(&json!({}))), None);
        assert_eq!(
            extract_replayed_result::<String>(Some(&json!("nope"))),
            None
        );
        assert_eq!(extract_replayed_result::<String>(None), None);
    }

    #[test]
    fn the_scope_defaults_persona_and_workspace() {
        let scope = to_world_model_scope(&input(None, None));
        let parts = scope.parts();
        assert_eq!(parts.user_id, "u1");
        assert_eq!(parts.persona_id, "default");
        assert_eq!(parts.workspace_id, "");
        let explicit = to_world_model_scope(&input(Some("p2"), Some("w2")));
        let parts = explicit.parts();
        assert_eq!(parts.persona_id, "p2");
        assert_eq!(parts.workspace_id, "w2");
    }
}
