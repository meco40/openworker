//! Port of `src/server/world-model/runtime/prospectiveRuntime.ts:1-61` — the
//! scheduler tick that reconciles due open loops and scans the heartbeat.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `prospectiveRuntime.ts:7-12` (`ProspectiveRuntimeDeps`) | [`ProspectiveRuntimeDeps`] |
//! | `prospectiveRuntime.ts:14-18` (result shape) | [`ProspectiveRuntimeResult`] |
//! | `prospectiveRuntime.ts:19-61` (`runProspectiveRuntimeOnce`) | [`run_prospective_runtime_once`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:33-34` and `:48-49` wrap each call
//!    in `runWithWorldModelScope(scope, …)`; the port hands the same scope to
//!    [`deliver_due_open_loops`] and [`scan_heartbeat`], whose scope parameter is
//!    the documented replacement for the `AsyncLocalStorage` (`db.ts:11`).
//! 2. **`config` and `now` are parameters.** `:22` reads `getWorldModelConfig()`
//!    and `:51` calls `new Date().toISOString()`, so the port takes both and a
//!    test never touches the process environment or the wall clock.
//! 3. **The heartbeat scan runs sequentially.** `:46-54` uses `Promise.all`; the
//!    port awaits the scans one after the other. The aggregated answer
//!    (`some(needsReconcile)`) and the per-scope failure isolation are identical,
//!    only the interleaving of independent connections differs.
//! 4. **`listRuntimeWorldModelScopes()` takes its inputs explicitly.** `:30`
//!    reads the environment, the SQLite message store and the runtime role; the
//!    ported discovery function already takes `env`, an optional executor and the
//!    role, so this module forwards them.
//! 5. **A failure is the zero result of the ported types.** `:35-42` and `:48-53`
//!    substitute object literals; the port substitutes
//!    [`DeliverDueOpenLoopsResult::empty`] and a
//!    [`HeartbeatScanResult`] with no overdue loop, `needs_reconcile: false` and
//!    the injected `now` as `scanned_at`.

use std::collections::HashMap;
use std::sync::Arc;

use crate::world_model::config::{RuntimeRole, WorldModelConfig};
use crate::world_model::db::{BoxFuture, PgExecutor};
use crate::world_model::runtime::heartbeat_runtime::{
    scan_heartbeat, HeartbeatRuntimeOptions, HeartbeatScanResult,
};
use crate::world_model::runtime::scope_discovery::list_runtime_world_model_scopes;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::open_loop_service::{
    deliver_due_open_loops, DeliverDueOpenLoopsResult,
};

/// `ProspectiveRuntimeDeps` from `prospectiveRuntime.ts:7-12`.
///
/// Rust has no optional-property object, so the two optional callbacks are
/// `Option<Arc<…>>`: `None` is the absent property, `Some` the provided one.
pub struct ProspectiveRuntimeDeps {
    /// `isActive?: () => boolean` — `:8`.
    pub is_active: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    /// `listUserPersonaScopes?: () => Promise<…>` — `:9-11`.
    pub list_user_persona_scopes:
        Option<Arc<dyn Fn() -> BoxFuture<'static, Vec<WorldModelScope>> + Send + Sync>>,
}

impl Default for ProspectiveRuntimeDeps {
    fn default() -> Self {
        Self {
            is_active: None,
            list_user_persona_scopes: None,
        }
    }
}

/// The `{ openLoopsDelivered, heartbeatReconcile, scopes }` answer of `:19-21`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProspectiveRuntimeResult {
    pub open_loops_delivered: i64,
    pub heartbeat_reconcile: bool,
    pub scopes: usize,
}

/// `runProspectiveRuntimeOnce(deps)` — `prospectiveRuntime.ts:19-61`.
pub async fn run_prospective_runtime_once(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    env: &HashMap<String, String>,
    runtime_role: RuntimeRole,
    now: &str,
    deps: ProspectiveRuntimeDeps,
) -> ProspectiveRuntimeResult {
    let active = match deps.is_active.as_ref() {
        Some(is_active) => is_active(),
        None => config.enabled,
    };
    if !active {
        return ProspectiveRuntimeResult {
            open_loops_delivered: 0,
            heartbeat_reconcile: false,
            scopes: 0,
        };
    }

    let scopes = match deps.list_user_persona_scopes.as_ref() {
        Some(list_user_persona_scopes) => list_user_persona_scopes().await,
        None => list_runtime_world_model_scopes(env, Some(executor), runtime_role).await,
    };

    let mut total_delivered = 0;
    for scope in &scopes {
        let workspace_id = scope.workspace_id.clone().unwrap_or_default();
        let delivered = deliver_due_open_loops(
            executor,
            Some(scope),
            config,
            &scope.user_id,
            &scope.persona_id,
            &workspace_id,
            now,
            None,
        )
        .await
        .unwrap_or_else(|_| DeliverDueOpenLoopsResult::empty());
        total_delivered += delivered.delivered + delivered.enqueued;
    }

    let mut heartbeat_reconcile = false;
    for scope in &scopes {
        let heartbeat = scan_heartbeat(
            executor,
            Some(scope),
            HeartbeatRuntimeOptions::default(),
            Some(now),
        )
        .await
        .unwrap_or_else(|_| HeartbeatScanResult {
            overdue_open_loops: Vec::new(),
            needs_reconcile: false,
            scanned_at: now.to_string(),
        });
        heartbeat_reconcile |= heartbeat.needs_reconcile;
    }

    ProspectiveRuntimeResult {
        open_loops_delivered: total_delivered,
        heartbeat_reconcile,
        scopes: scopes.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgValue, SQL_SET_SCOPE};
    use serde_json::json;

    fn count_row() -> PgQueryResult {
        PgQueryResult::from_rows(vec![json!({ "count": "0" }).as_object().unwrap().clone()])
    }

    #[test]
    fn an_inactive_runtime_returns_the_zero_result_without_a_statement() {
        let executor = RecordingExecutor::new(vec![]);
        let result = drive_sync(run_prospective_runtime_once(
            &executor,
            &WorldModelConfig::default(),
            &HashMap::new(),
            RuntimeRole::App,
            "2026-10-11T12:00:00.000Z",
            ProspectiveRuntimeDeps::default(),
        ))
        .expect("bridge");
        assert_eq!(
            result,
            ProspectiveRuntimeResult {
                open_loops_delivered: 0,
                heartbeat_reconcile: false,
                scopes: 0
            }
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn every_injected_scope_runs_its_due_scan_and_heartbeat_under_its_own_triple() {
        // Due list (empty), asked-today count, cumulative scan, overdue scan.
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(count_row()),
            Ok(PgQueryResult::empty()),
        ]);
        let scopes = Arc::new(|| -> BoxFuture<'static, Vec<WorldModelScope>> {
            Box::pin(async { vec![WorldModelScope::new("u1", "p1", Some("w1".to_string()))] })
        });
        let deps = ProspectiveRuntimeDeps {
            is_active: None,
            list_user_persona_scopes: Some(scopes),
        };
        let result = drive_sync(run_prospective_runtime_once(
            &executor,
            &WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            &HashMap::new(),
            RuntimeRole::App,
            "2026-10-11T12:00:00.000Z",
            deps,
        ))
        .expect("bridge");
        assert_eq!(
            result,
            ProspectiveRuntimeResult {
                open_loops_delivered: 0,
                heartbeat_reconcile: false,
                scopes: 1
            }
        );
        let calls = executor.calls();
        match &calls[1] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_SET_SCOPE);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text("w1")
                    ]
                );
            }
            other => panic!("expected the scope statement, got {other:?}"),
        }
        assert!(calls
            .iter()
            .any(|call| call.sql().contains("FROM world_model_open_loops")));
        assert!(calls
            .iter()
            .any(|call| call.sql().contains("updated_at <= $1")));
    }
}
