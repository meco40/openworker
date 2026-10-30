//! Seam for `src/server/world-model/services/masterActionBridge.ts` (S6).
//!
//! `bridgeMasterAction` is the only export the S9 consumers call:
//! `connectors/gmail/actions.ts` (`bridgeMasterAction` at its send path) and
//! `execution/runtime/toolRunner.ts` (`runCanonicalMasterAction` and the shell
//! branch). The port declares the call as [`MasterActionBridge`] so the S6
//! implementation can land without changing a consumer. No implementation is
//! provided in this crate (OP-S9-4).
//!
//! # Async shape
//!
//! The source is `async`, and its `run` callback is an async closure that the
//! bridge awaits. The trait therefore returns a boxed future. The future is
//! `Send`: the master repository is `Send + Sync` ([`MasterRepository`]), so the
//! closures may capture it, and the Axum handlers can await the bridge. A
//! rejected promise becomes `Err(message)`. The same applies when `run` rejects.
//!
//! [`MasterRepository`]: crate::master::repository::MasterRepository

use futures_util::future::BoxFuture;
use serde_json::Value;

/// The `run` result of `MasterActionBridgeInput.run` — the source's
/// `{ ok, error?, result, receipt? }`. `result: T` is carried as a [`Value`].
#[derive(Debug, Clone, PartialEq)]
pub struct MasterActionRun {
    pub ok: bool,
    pub error: Option<String>,
    pub result: Value,
    pub receipt: Option<Value>,
}

/// `MasterActionBridgeInput` from `masterActionBridge.ts`.
pub struct MasterActionBridgeInput<'a> {
    pub user_id: String,
    /// `personaId?` — absent becomes `'default'` in the S6 scope mapping.
    pub persona_id: Option<String>,
    /// `workspaceId?` — absent becomes `''` in the S6 scope mapping.
    pub workspace_id: Option<String>,
    pub task_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
    /// `run: () => Promise<{ ok, error?, result, receipt? }>`. A rejection is
    /// `Err(message)`.
    pub run: Box<dyn FnOnce() -> BoxFuture<'a, Result<MasterActionRun, String>> + Send + 'a>,
}

/// `MasterActionBridgeResult` from `masterActionBridge.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct MasterActionBridgeResult {
    pub attempt_id: String,
    pub succeeded: bool,
    pub created: bool,
    pub error: Option<String>,
    pub replayed: bool,
    pub result: Option<Value>,
    pub receipt: Option<Value>,
}

/// The `bridgeMasterAction` call of `masterActionBridge.ts`. `Err` is a
/// rejected promise of the source.
pub trait MasterActionBridge: Send + Sync {
    fn bridge_master_action<'a>(
        &'a self,
        input: MasterActionBridgeInput<'a>,
    ) -> BoxFuture<'a, Result<MasterActionBridgeResult, String>>;
}

/// Helper for implementations: boxes a `Send` future as the trait's return type.
pub fn boxed<'a, T>(future: impl std::future::Future<Output = T> + Send + 'a) -> BoxFuture<'a, T> {
    Box::pin(future)
}
