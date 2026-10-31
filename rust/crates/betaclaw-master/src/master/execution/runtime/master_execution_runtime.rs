//! Port of `src/server/master/execution/runtime/masterExecutionRuntime.ts:1-131`.
//!
//! The owner of one Master run's lease: claim, run the flow while renewing the
//! lease, release, and export a bundle.
//!
//! # No background threads: `startBackground` runs inline
//!
//! `startBackground` (`:25-37`) stores a `Promise` in a `Map` and returns `true`
//! immediately. Rust cannot start that promise without a thread, so the port runs
//! the flow inline and removes the key when it returns; [`is_running`] is only
//! ever `true` during that call. `waitForRun`/`waitForAllRuns` (`:56-68`) become
//! no-ops for the same reason (OP-S9-15).
//!
//! # The lease heartbeat is a seam
//!
//! `setInterval(renewLease, 15_000)` / `clearInterval` (`:114-129`) is a
//! process-wide timer. The initial `renewLease()` call and the `clearInterval` in
//! the `finally` run here; the repeated ticks are delegated to
//! [`RuntimeLeaseHeartbeat`] (OP-S9-15), whose default never ticks.

use std::cell::RefCell;
use std::collections::HashSet;

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::Value;

use crate::master::execution::approval_policy::ToolPolicyResolver;
use crate::master::execution::runtime::capability_executor::MasterToolRunner;
use crate::master::execution::runtime::execution_flow::{
    execute_master_run_flow, ExecuteMasterRunFlowInput, MasterExecutionFlowError,
};
use crate::master::execution::runtime::execution_plan::MasterModelDispatch;
use crate::master::execution::runtime::json_parsing::parse_json_object;
use crate::master::execution::runtime::types::{
    MasterRunExportBundle, MasterRunExportDelegations, RuntimeMode,
};
use crate::master::feature_flags::MasterEnv;
use crate::master::live_events::MasterEventPublisher;
use crate::master::orchestrator::MasterOrchestrator;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterRun, WorkspaceScope};
use crate::master::workspace_scope::MasterWorkspaceBinding;
use crate::personas::repository::PersonaRepository;

/// `15_000` — `masterExecutionRuntime.ts:117`.
pub const RUNTIME_HEARTBEAT_INTERVAL_MS: u64 = 15_000;

/// `60_000` — `masterExecutionRuntime.ts:28,40,110`.
pub const RUNTIME_LEASE_MS: i64 = 60_000;

/// The three `throw`s of `masterExecutionRuntime.ts:42,51,73`.
#[derive(Debug, thiserror::Error)]
pub enum MasterExecutionRuntimeError {
    #[error("Master run is already claimed by another runtime.")]
    RunAlreadyClaimed,
    #[error("Master run not found.")]
    RunNotFound,
    #[error("Run not found")]
    ExportRunNotFound,
    #[error(transparent)]
    Flow(#[from] MasterExecutionFlowError),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// `setInterval(renewLease, 15_000)` / `clearInterval(handle)`.
pub trait RuntimeLeaseHeartbeat: Send + Sync {
    /// `setInterval(renewLease, heartbeatIntervalMs)`.
    fn schedule(&self, interval_ms: u64);
    /// `clearInterval(heartbeat)`.
    fn cancel(&self);
}

/// The default: log and continue.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopRuntimeLeaseHeartbeat;

impl RuntimeLeaseHeartbeat for NoopRuntimeLeaseHeartbeat {
    fn schedule(&self, interval_ms: u64) {
        tracing::debug!(interval_ms, "master runtime heartbeat scheduled (no timer)");
    }

    fn cancel(&self) {
        tracing::debug!("master runtime heartbeat cancelled");
    }
}

/// The injectable collaborators of `executeMasterRunFlow`.
pub struct ExecutionFlowDeps<'a> {
    pub persona_repo: &'a PersonaRepository,
    pub env: &'a MasterEnv,
    pub model: &'a dyn MasterModelDispatch,
    pub tool_runner: &'a dyn MasterToolRunner,
    pub tool_policy: &'a dyn ToolPolicyResolver,
    pub publisher: &'a dyn MasterEventPublisher,
}

/// `MasterExecutionRuntime` from `masterExecutionRuntime.ts:12-131`.
pub struct MasterExecutionRuntime<'a> {
    repo: &'a dyn MasterRepository,
    orchestrator: &'a MasterOrchestrator<'a>,
    deps: ExecutionFlowDeps<'a>,
    owner_id: String,
    running: RefCell<HashSet<String>>,
    heartbeat: &'a dyn RuntimeLeaseHeartbeat,
    now: fn() -> DateTime<Utc>,
}

impl<'a> MasterExecutionRuntime<'a> {
    /// `constructor(repo, orchestrator)` — `masterExecutionRuntime.ts:16-19`.
    ///
    /// `Math.random().toString(36).slice(2)` is a random alphanumeric tag; the
    /// port uses the first 11 hex characters of a UUID (OP-S9-15).
    pub fn new(
        repo: &'a dyn MasterRepository,
        orchestrator: &'a MasterOrchestrator<'a>,
        deps: ExecutionFlowDeps<'a>,
        heartbeat: &'a dyn RuntimeLeaseHeartbeat,
    ) -> Self {
        let owner_id = format!(
            "master-runtime-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..11]
        );
        Self {
            repo,
            orchestrator,
            deps,
            owner_id,
            running: RefCell::new(HashSet::new()),
            heartbeat,
            now: chrono_now,
        }
    }

    /// Overrides the clock (`Date.now()`), for tests.
    pub fn with_now(mut self, now: fn() -> DateTime<Utc>) -> Self {
        self.now = now;
        self
    }

    /// `key(scope, runId)` — `masterExecutionRuntime.ts:94-96`.
    fn key(scope: &WorkspaceScope, run_id: &str) -> String {
        format!("{}::{}::{}", scope.user_id, scope.workspace_id, run_id)
    }

    fn lease_expires_at(&self) -> String {
        ((self.now)() + ChronoDuration::milliseconds(RUNTIME_LEASE_MS))
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// `isRunning` — `masterExecutionRuntime.ts:21-23`.
    pub fn is_running(&self, scope: &WorkspaceScope, run_id: &str) -> bool {
        self.running.borrow().contains(&Self::key(scope, run_id))
    }

    /// `startBackground` — `masterExecutionRuntime.ts:25-37`.
    pub fn start_background(
        &self,
        scope: &MasterWorkspaceBinding,
        run_id: &str,
    ) -> Result<bool, MasterExecutionRuntimeError> {
        let ws = binding_scope(scope);
        let key = Self::key(&ws, run_id);
        if self.running.borrow().contains(&key) {
            return Ok(false);
        }
        let lease_expires_at = self.lease_expires_at();
        if self
            .repo
            .claim_run(&ws, run_id, &self.owner_id, &lease_expires_at)?
            .is_none()
        {
            return Ok(false);
        }
        self.running.borrow_mut().insert(key.clone());
        let result = self.execute(scope, run_id);
        self.running.borrow_mut().remove(&key);
        let _ = self.repo.release_run_lease(&ws, run_id, &self.owner_id);
        result?;
        Ok(true)
    }

    /// `executeNow` — `masterExecutionRuntime.ts:39-54`.
    pub fn execute_now(
        &self,
        scope: &MasterWorkspaceBinding,
        run_id: &str,
    ) -> Result<MasterRun, MasterExecutionRuntimeError> {
        let ws = binding_scope(scope);
        let lease_expires_at = self.lease_expires_at();
        if self
            .repo
            .claim_run(&ws, run_id, &self.owner_id, &lease_expires_at)?
            .is_none()
        {
            return Err(MasterExecutionRuntimeError::RunAlreadyClaimed);
        }
        let result = self.execute(scope, run_id);
        let _ = self.repo.release_run_lease(&ws, run_id, &self.owner_id);
        result?;
        self.repo
            .get_run(&ws, run_id)?
            .ok_or(MasterExecutionRuntimeError::RunNotFound)
    }

    /// `waitForRun` — `masterExecutionRuntime.ts:56-62` (a no-op, see the header).
    pub fn wait_for_run(&self, _scope: &WorkspaceScope, _run_id: &str) {}

    /// `waitForAllRuns` — `masterExecutionRuntime.ts:64-68` (a no-op).
    pub fn wait_for_all_runs(&self) {}

    /// `buildExportBundle` — `masterExecutionRuntime.ts:70-92`.
    pub fn build_export_bundle(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> Result<MasterRunExportBundle, MasterExecutionRuntimeError> {
        let run = self
            .repo
            .get_run(scope, run_id)?
            .ok_or(MasterExecutionRuntimeError::ExportRunNotFound)?;
        let steps = to_values(self.repo.list_steps(scope, run_id)?)?;
        let jobs = to_values(self.repo.list_delegation_jobs(scope, run_id)?)?;
        let events = to_values(self.repo.list_delegation_events(scope, run_id)?)?;
        let parsed_bundle: Option<Value> = match run.result_bundle.as_deref() {
            Some(bundle) => parse_json_object(bundle),
            None => None,
        };
        let verification_report = parsed_bundle
            .as_ref()
            .and_then(|bundle| bundle.get("verificationReport"))
            .filter(|value| !value.is_null())
            .cloned();
        let execution_mode = parsed_bundle
            .as_ref()
            .and_then(|bundle| bundle.get("executionMode"))
            .and_then(Value::as_str)
            .and_then(RuntimeMode::parse);
        Ok(MasterRunExportBundle {
            run_id: run_id.to_string(),
            status: run.status.clone(),
            run,
            steps,
            delegations: MasterRunExportDelegations { jobs, events },
            verification_report,
            execution_mode,
            exported_at: (self.now)().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    /// `nextStepSequence` — `masterExecutionRuntime.ts:98-102`.
    fn next_step_sequence(&self, scope: &MasterWorkspaceBinding, run_id: &str) -> i64 {
        let ws = binding_scope(scope);
        let steps = self.repo.list_steps(&ws, run_id).unwrap_or_default();
        if steps.is_empty() {
            1
        } else {
            steps.iter().map(|step| step.seq).max().unwrap_or(0) + 1
        }
    }

    /// `execute` — `masterExecutionRuntime.ts:104-130`.
    fn execute(
        &self,
        scope: &MasterWorkspaceBinding,
        run_id: &str,
    ) -> Result<(), MasterExecutionRuntimeError> {
        let ws = binding_scope(scope);
        let renew_lease = || {
            let _ = self.repo.renew_run_lease(
                &ws,
                run_id,
                &self.owner_id,
                &self.lease_expires_at(),
                &(self.now)().to_rfc3339_opts(SecondsFormat::Millis, true),
            );
        };

        renew_lease();
        self.heartbeat.schedule(RUNTIME_HEARTBEAT_INTERVAL_MS);
        let next = |scope: &MasterWorkspaceBinding, run_id: &str| -> i64 {
            self.next_step_sequence(scope, run_id)
        };
        let result = execute_master_run_flow(&ExecuteMasterRunFlowInput {
            scope,
            run_id,
            repo: self.repo,
            orchestrator: self.orchestrator,
            next_step_sequence: &next,
            persona_repo: self.deps.persona_repo,
            env: self.deps.env,
            model: self.deps.model,
            tool_runner: self.deps.tool_runner,
            tool_policy: self.deps.tool_policy,
            publisher: self.deps.publisher,
            now: self.now,
        });
        self.heartbeat.cancel();
        Ok(result?)
    }
}

fn binding_scope(scope: &MasterWorkspaceBinding) -> WorkspaceScope {
    WorkspaceScope {
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
    }
}

fn chrono_now() -> DateTime<Utc> {
    Utc::now()
}

fn to_values<T: serde::Serialize>(
    items: Vec<T>,
) -> Result<Vec<Value>, MasterExecutionRuntimeError> {
    items
        .into_iter()
        .map(|item| serde_json::to_value(item).map_err(MasterExecutionRuntimeError::from))
        .collect()
}
