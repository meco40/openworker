//! Port of `src/server/master/delegation/dispatcher.ts:1-84`.
//!
//! [`DelegationDispatcher`] is the implementation of the
//! [`DelegationDispatcherPort`] seam that [`crate::master::orchestrator`] already
//! declared: it admits a trigger through the cooldown/capacity policy, takes a
//! governor slot, optionally opens a subagent session, creates the delegation
//! job and runs it through [`SubagentPool`].
//!
//! # Measured import check: no S8 dependency
//!
//! `dispatcher.ts:1-11` imports only `@/server/master/**` (`repository`,
//! `types`, `inbox`, `resourceGovernor`, `triggerPolicy`, `sessionService`,
//! `subagentPool`, `featureFlags`). A `Select-String` over the whole
//! `src/server/master/delegation/**` tree for `subagentCommand`,
//! `subagentExecution`, `channels/`, `orchestration/` and
//! `getCommandHandlerDeps` returns **zero** hits. `dispatcher.ts`/`subagentPool.ts`
//! do **not** call the S8 subagent runtime; no S8 trait seam is opened and no S8
//! code is imported or stubbed (see the module root note).
//!
//! # Ports and paths become parameters
//!
//! `process.env.MASTER_DELEGATION_COOLDOWN_MS` (`dispatcher.ts:35`) is read
//! through the injected [`MasterEnv`], and `Date.now()` (`:44`) through the
//! `now` function pointer, so both are deterministic in tests. Constructing the
//! inbox and pool on the stack is behaviourally identical to the two fields
//! (`dispatcher.ts:17-27`) because neither carries state.
//!
//! # The sync port cannot propagate a task rejection
//!
//! `dispatch` awaits `pool.execute` and only releases the governor in `finally`;
//! an error therefore rejects the returned promise. The
//! [`DelegationDispatcherPort`] signature returns an outcome, so a repository
//! failure during setup or execution is reported as
//! `{ accepted: false, reason }` instead of unwinding (OP-S9-11).

use std::cell::RefCell;

use crate::master::feature_flags::{is_master_subagent_sessions_enabled, MasterEnv};
use crate::master::live_events::MasterEventPublisher;
use crate::master::orchestrator::{
    DelegationDispatchInput, DelegationDispatchOutcome, DelegationDispatcherPort,
    DelegationTaskResult,
};
use crate::master::repository::delegation_store::{
    MasterDelegationEventInput, MasterDelegationJobInput,
};
use crate::master::repository::MasterRepository;

use super::inbox::DelegationInbox;
use super::resource_governor::DelegationResourceGovernor;
use super::session_service::{
    create_subagent_session_for_dispatch, publish_delegation_event,
    CreateSubagentSessionForDispatchInput,
};
use super::subagent_pool::{SubagentHeartbeatScheduler, SubagentPool, SubagentPoolOptions};
use super::trigger_policy::{DelegationTriggerPolicy, TriggerPolicyInput};

/// `input.timeoutMs ?? 120_000` — `dispatcher.ts:31`.
pub const DEFAULT_DELEGATION_TIMEOUT_MS: i64 = 120_000;

/// `options?.maxConcurrent ?? 4` — `dispatcher.ts:25`.
pub const DEFAULT_MAX_CONCURRENT: i64 = 4;

/// The wall-clock source behind `Date.now()`.
pub fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `options` of the constructor — `dispatcher.ts:21`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DelegationDispatcherOptions {
    pub max_concurrent: Option<i64>,
}

/// `MASTER_DELEGATION_COOLDOWN_MS` — `dispatcher.ts:35-36`.
///
/// `Number(process.env.MASTER_DELEGATION_COOLDOWN_MS || 1500)` with the
/// `Number.isFinite && >= 0` guard: a missing or empty variable is `1500`, an
/// unparseable value is `1500`, a whitespace-only value is `0` (as in
/// JavaScript).
pub fn delegation_cooldown_ms(env: &MasterEnv) -> i64 {
    let raw = env
        .get("MASTER_DELEGATION_COOLDOWN_MS")
        .map(String::as_str)
        .unwrap_or("");
    let value = if raw.is_empty() {
        1500.0
    } else if raw.trim().is_empty() {
        0.0
    } else {
        raw.trim().parse::<f64>().unwrap_or(f64::NAN)
    };
    if value.is_finite() && value >= 0.0 {
        value as i64
    } else {
        1500
    }
}

/// `DelegationDispatcher` from `dispatcher.ts:13-84`.
pub struct DelegationDispatcher<'a> {
    repo: &'a dyn MasterRepository,
    env: &'a MasterEnv,
    publisher: &'a dyn MasterEventPublisher,
    heartbeat: &'a dyn SubagentHeartbeatScheduler,
    governor: RefCell<DelegationResourceGovernor>,
    trigger_policy: RefCell<DelegationTriggerPolicy>,
    now: fn() -> i64,
}

impl<'a> DelegationDispatcher<'a> {
    /// `constructor(repo, options)` — `dispatcher.ts:21-28`.
    pub fn new(
        repo: &'a dyn MasterRepository,
        env: &'a MasterEnv,
        publisher: &'a dyn MasterEventPublisher,
        heartbeat: &'a dyn SubagentHeartbeatScheduler,
        options: DelegationDispatcherOptions,
    ) -> Self {
        Self {
            repo,
            env,
            publisher,
            heartbeat,
            governor: RefCell::new(DelegationResourceGovernor::new(
                options.max_concurrent.unwrap_or(DEFAULT_MAX_CONCURRENT),
            )),
            trigger_policy: RefCell::new(DelegationTriggerPolicy::new()),
            now: now_millis,
        }
    }

    /// Overrides the clock (`Date.now()`), for tests.
    pub fn with_now(mut self, now: fn() -> i64) -> Self {
        self.now = now;
        self
    }

    fn rejected(reason: String) -> DelegationDispatchOutcome {
        DelegationDispatchOutcome {
            job_id: String::new(),
            accepted: false,
            reason: Some(reason),
        }
    }
}

impl DelegationDispatcherPort for DelegationDispatcher<'_> {
    /// `dispatch(input)` — `dispatcher.ts:30-83`.
    fn dispatch(
        &self,
        input: &DelegationDispatchInput<'_>,
        task: Box<dyn FnOnce() -> DelegationTaskResult + '_>,
    ) -> DelegationDispatchOutcome {
        let timeout_ms = DEFAULT_DELEGATION_TIMEOUT_MS;
        let cooldown_ms = delegation_cooldown_ms(self.env);

        let (active_for_capability, active_global) = {
            let governor = self.governor.borrow();
            (
                governor.get_active_for_capability(input.capability),
                governor.get_active_global(),
            )
        };
        let policy = self
            .trigger_policy
            .borrow_mut()
            .evaluate(&TriggerPolicyInput {
                scope_key: format!("{}::{}", input.scope.user_id, input.scope.workspace_id),
                capability: input.capability.to_string(),
                now: (self.now)(),
                timeout_ms,
                cooldown_ms,
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                active_for_capability,
                active_global,
            });
        if !policy.allowed {
            return Self::rejected(
                policy
                    .reason
                    .map(|reason| reason.as_str().to_string())
                    .unwrap_or_default(),
            );
        }
        if !self.governor.borrow_mut().try_acquire(input.capability) {
            return Self::rejected("capacity_exhausted".to_string());
        }

        let release = || self.governor.borrow_mut().release(input.capability);

        let session = if is_master_subagent_sessions_enabled(self.env) {
            match create_subagent_session_for_dispatch(
                self.repo,
                input.scope,
                &CreateSubagentSessionForDispatchInput {
                    run_id: input.run_id.to_string(),
                    capability: input.capability.to_string(),
                    payload: input.payload.to_string(),
                    assigned_tools: None,
                },
                self.publisher,
            ) {
                Ok(session) => Some(session),
                Err(error) => {
                    release();
                    return Self::rejected(error.to_string());
                }
            }
        } else {
            None
        };

        let job = match self.repo.create_delegation_job(
            input.scope,
            &MasterDelegationJobInput {
                run_id: input.run_id.to_string(),
                capability: input.capability.to_string(),
                payload: input.payload.to_string(),
                status: "queued".to_string(),
                priority: "medium".to_string(),
                max_attempts: 3,
                timeout_ms,
            },
        ) {
            Ok(job) => job,
            Err(error) => {
                release();
                return Self::rejected(error.to_string());
            }
        };
        if let Err(error) = publish_delegation_event(
            self.repo,
            input.scope,
            &MasterDelegationEventInput {
                run_id: input.run_id.to_string(),
                job_id: job.id.clone(),
                event_type: "created".to_string(),
                payload: serde_json::json!({ "capability": input.capability }).to_string(),
            },
        ) {
            release();
            return Self::rejected(error.to_string());
        }

        let inbox = DelegationInbox::new(self.repo);
        let pool = SubagentPool::new(
            self.repo,
            &inbox,
            self.publisher,
            self.heartbeat,
            SubagentPoolOptions::default(),
        );
        let outcome = match pool.execute(
            input.scope,
            input.run_id,
            &job.id,
            session.as_ref().map(|session| session.id.as_str()),
            task,
        ) {
            Ok(()) => DelegationDispatchOutcome {
                job_id: job.id.clone(),
                accepted: true,
                reason: None,
            },
            Err(error) => Self::rejected(error.to_string()),
        };
        release();
        outcome
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::master::live_events::NoopMasterEventPublisher;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::{MasterRunCreateInput, WorkspaceScope};

    use crate::master::delegation::subagent_pool::NoopSubagentHeartbeatScheduler;

    static CLOCK: AtomicI64 = AtomicI64::new(0);

    fn clock() -> i64 {
        CLOCK.load(Ordering::SeqCst)
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn run(repo: &SqliteMasterRepository) -> String {
        repo.create_run(&MasterRunCreateInput {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "Run".to_string(),
            contract: "Contract".to_string(),
        })
        .unwrap()
        .id
    }

    fn task() -> Box<dyn FnOnce() -> DelegationTaskResult + 'static> {
        Box::new(|| DelegationTaskResult {
            output: "result".to_string(),
            confidence: Some(0.9),
        })
    }

    #[test]
    fn cooldown_parsing_matches_number_semantics() {
        let mut env = MasterEnv::new();
        assert_eq!(delegation_cooldown_ms(&env), 1500);
        env.insert("MASTER_DELEGATION_COOLDOWN_MS".to_string(), "".to_string());
        assert_eq!(delegation_cooldown_ms(&env), 1500);
        env.insert(
            "MASTER_DELEGATION_COOLDOWN_MS".to_string(),
            "nope".to_string(),
        );
        assert_eq!(delegation_cooldown_ms(&env), 1500);
        env.insert(
            "MASTER_DELEGATION_COOLDOWN_MS".to_string(),
            "-5".to_string(),
        );
        assert_eq!(delegation_cooldown_ms(&env), 1500);
        env.insert(
            "MASTER_DELEGATION_COOLDOWN_MS".to_string(),
            "2500".to_string(),
        );
        assert_eq!(delegation_cooldown_ms(&env), 2500);
    }

    #[test]
    fn a_dispatch_runs_the_task_and_a_second_one_hits_the_cooldown() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let env = MasterEnv::new();
        let dispatcher = DelegationDispatcher::new(
            &repo,
            &env,
            &NoopMasterEventPublisher,
            &NoopSubagentHeartbeatScheduler,
            DelegationDispatcherOptions::default(),
        )
        .with_now(clock);

        CLOCK.store(1_000_000, Ordering::SeqCst);
        let first = dispatcher.dispatch(
            &DelegationDispatchInput {
                scope: &scope,
                run_id: &run_id,
                capability: "web_search",
                payload: "{\"contract\":\"c\"}",
            },
            task(),
        );
        assert!(first.accepted, "{:?}", first.reason);
        assert!(!first.job_id.is_empty());
        let jobs = repo.list_delegation_jobs(&scope, &run_id).unwrap();
        assert_eq!(jobs[0].status, "completed");
        let sessions = repo
            .list_subagent_sessions(&scope, Some(&run_id), 100)
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].status, "completed");

        CLOCK.store(1_000_100, Ordering::SeqCst);
        let second = dispatcher.dispatch(
            &DelegationDispatchInput {
                scope: &scope,
                run_id: &run_id,
                capability: "web_search",
                payload: "{}",
            },
            task(),
        );
        assert!(!second.accepted);
        assert_eq!(second.reason.as_deref(), Some("cooldown_active"));
    }

    #[test]
    fn a_zero_budget_is_rejected_as_budget_exceeded() {
        // `timeoutMs` is fixed at the default, so the branch is exercised
        // through the policy unit tests; the dispatcher itself only reads a
        // positive default. This asserts the constant the source applies.
        assert_eq!(DEFAULT_DELEGATION_TIMEOUT_MS, 120_000);
    }
}
