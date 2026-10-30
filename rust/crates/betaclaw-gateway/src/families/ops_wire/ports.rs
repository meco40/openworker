//! Ports of the ops family.
//!
//! Each trait covers one TypeScript collaborator that has no Rust implementation
//! yet: the health and doctor commands (`src/commands/*`), the World-Model metrics,
//! the Mission Control runtime client (`src/lib/betaclaw/client.ts`), the BetaClaw
//! session table and workspace access, and the channel pairing actions of
//! `src/server/channels/pairing/*`.
//!
//! The default method bodies answer [`PortError::NotWired`]. [`Unwired`] relies on
//! them and is the wiring until a real implementation replaces it. Every method
//! takes owned arguments, so the returned futures borrow only the port itself.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

/// Boxed future of the async port methods.
pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, PortError>> + Send + 'a>>;

/// Failure of a port call.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PortError {
    /// No implementation is wired in the Rust gateway yet.
    #[error("{0} is not wired in the Rust gateway yet")]
    NotWired(&'static str),
    /// The implementation ran and failed. The message is the error text.
    #[error("{0}")]
    Failed(String),
}

fn not_wired<'a, T: 'a>(what: &'static str) -> PortFuture<'a, T> {
    Box::pin(async move { Err(PortError::NotWired(what)) })
}

/// `runHealthCommand` and `runDoctorCommand`. The reports are returned as the
/// TypeScript commands build them, so the route code does not restate their shape.
pub trait DiagnosticsPort: Send + Sync {
    fn health(&self, _memory_diagnostics: bool) -> PortFuture<'_, Value> {
        not_wired("health command")
    }

    fn doctor(&self, _memory_diagnostics: bool) -> PortFuture<'_, Value> {
        not_wired("doctor command")
    }
}

/// World-Model health and metrics (`src/server/world-model/*`).
pub trait WorldModelPort: Send + Sync {
    /// The complete body of `GET /api/health/world-model`. `scheduler` is the
    /// automation metrics the route reads for check 8, or the error it hit.
    fn health(&self, _scheduler: Result<Value, String>) -> PortFuture<'_, Value> {
        not_wired("world-model health")
    }

    /// The projection `getWorldModelMetrics` feeds into control-plane metrics.
    fn metrics(&self) -> PortFuture<'_, Value> {
        not_wired("world-model metrics")
    }
}

/// Control-plane figures that have no Rust store yet.
pub trait ControlPlanePort: Send + Sync {
    /// `process.memoryUsage().rss`. `None` serialises as `null`.
    fn ram_usage_bytes(&self) -> Option<u64> {
        None
    }

    /// `resolveVectorNodeCountSafe`. A failure is `-1` at the call site.
    fn vector_node_count(&self, _user_id: String) -> PortFuture<'_, i64> {
        not_wired("vector node count")
    }

    /// `getKnowledgeRepository().getKnowledgeStats`. A failure is `null`.
    fn knowledge_metrics(&self, _user_id: String) -> PortFuture<'_, Value> {
        not_wired("knowledge metrics")
    }

    /// `getInboxObservabilitySnapshot`.
    fn inbox_observability(&self) -> PortFuture<'_, Value> {
        not_wired("inbox observability")
    }
}

/// Channel pairing actions and their snapshots.
pub trait ChannelPairingPort: Send + Sync {
    /// `pairChannel`. The returned value is the TypeScript result object.
    fn connect(
        &self,
        _channel: String,
        _token: String,
        _account_id: Option<String>,
    ) -> PortFuture<'_, Value> {
        not_wired("channel pairing")
    }

    fn disconnect(&self, _channel: String, _account_id: Option<String>) -> PortFuture<'_, ()> {
        not_wired("channel unpairing")
    }

    fn rotate_secret(&self, _channel: String, _account_id: String) -> PortFuture<'_, ()> {
        not_wired("bridge secret rotation")
    }

    fn reject_pending_telegram(&self) -> PortFuture<'_, bool> {
        not_wired("telegram pairing")
    }

    /// `getTelegramPairingSnapshot`.
    fn telegram_pairing(&self) -> PortFuture<'_, Value> {
        not_wired("telegram pairing snapshot")
    }

    /// `listBridgeAccounts(channel)`, the account array of a bridge channel.
    fn bridge_accounts(&self, _channel: String) -> PortFuture<'_, Value> {
        not_wired("bridge accounts")
    }
}

/// Mission Control runtime, the BetaClaw session table and workspace access.
pub trait BetaClawPort: Send + Sync {
    /// `client.isConnected()`.
    fn runtime_connected(&self) -> bool {
        false
    }

    /// `client.connect()`.
    fn runtime_connect(&self) -> PortFuture<'_, ()> {
        not_wired("Mission Control runtime client")
    }

    /// `(gateway_url, mode)` as `client.getGatewayUrl()` and `client.getMode()`.
    fn runtime_endpoint(&self) -> Result<(String, String), PortError> {
        Err(PortError::NotWired("Mission Control runtime client"))
    }

    /// `client.listSessions()`.
    fn runtime_list_sessions(&self) -> PortFuture<'_, Vec<Value>> {
        not_wired("Mission Control runtime client")
    }

    /// `client.createSession(channel, peer, workspaceId)`.
    fn runtime_create_session(
        &self,
        _channel: String,
        _peer: Value,
        _workspace_id: String,
    ) -> PortFuture<'_, Value> {
        not_wired("Mission Control runtime client")
    }

    /// `client.sendMessage(id, content)`.
    fn runtime_send_message(&self, _session_id: String, _content: String) -> PortFuture<'_, ()> {
        not_wired("Mission Control runtime client")
    }

    /// `getAccessibleWorkspaceIds(userContext)`.
    fn accessible_workspace_ids(&self, _user_id: String) -> PortFuture<'_, Vec<String>> {
        not_wired("workspace access")
    }

    /// `hasWorkspaceAccess(userContext, workspaceId)`.
    fn has_workspace_access(
        &self,
        _user_id: String,
        _workspace_id: String,
    ) -> PortFuture<'_, bool> {
        not_wired("workspace access")
    }

    /// `canAccessSession(userContext, sessionId)`.
    fn can_access_session(&self, _user_id: String, _session_id: String) -> PortFuture<'_, bool> {
        not_wired("workspace access")
    }

    /// `getAccessibleSessionCount(userContext)`.
    fn accessible_session_count(&self, _user_id: String) -> PortFuture<'_, usize> {
        not_wired("workspace access")
    }

    /// `SELECT s.* FROM betaclaw_sessions` filtered by workspace, type and status.
    fn db_sessions(
        &self,
        _workspace_ids: Vec<String>,
        _session_type: Option<String>,
        _status: Option<String>,
    ) -> PortFuture<'_, Vec<Value>> {
        not_wired("BetaClaw session table")
    }

    /// The `betaclaw_session_id` values of the accessible rows.
    fn db_runtime_session_ids(&self, _workspace_ids: Vec<String>) -> PortFuture<'_, Vec<String>> {
        not_wired("BetaClaw session table")
    }

    /// The row whose `betaclaw_session_id` equals `session_id`, if any.
    fn db_find_runtime_session(&self, _session_id: String) -> PortFuture<'_, Option<Value>> {
        not_wired("BetaClaw session table")
    }

    /// The row whose `betaclaw_session_id` or `id` equals `session_id`, if any.
    fn db_find_session(&self, _session_id: String) -> PortFuture<'_, Option<Value>> {
        not_wired("BetaClaw session table")
    }

    /// Applies `status` / `ended_at` to the row, completes the agent when the
    /// status is `completed`, and returns the updated row.
    fn db_patch_session(
        &self,
        _row: Value,
        _status: Option<Value>,
        _ended_at: Option<Value>,
    ) -> PortFuture<'_, Value> {
        not_wired("BetaClaw session table")
    }

    /// Deletes the row, its auto-created sub-agent, and emits the event.
    fn db_delete_session(&self, _row: Value) -> PortFuture<'_, ()> {
        not_wired("BetaClaw session table")
    }
}

/// Stand-in wiring for every port that has no implementation yet.
#[derive(Debug, Default, Clone, Copy)]
pub struct Unwired;

impl DiagnosticsPort for Unwired {}
impl WorldModelPort for Unwired {}
impl ControlPlanePort for Unwired {}
impl ChannelPairingPort for Unwired {}
impl BetaClawPort for Unwired {}
