//! Port of `src/server/master/orchestrator.ts:1-118`.
//!
//! The run driver: advance a run through the lifecycle, apply an approval
//! decision, delegate one capability and execute a side effect exactly once.
//!
//! # Two dependencies of this file belong to later packages
//!
//! `orchestrator.ts:5-7` imports `DelegationDispatcher` (package P3),
//! `MasterActionLedgerService` and `buildIdempotencyKey` (both package P4). The
//! constructor builds the two services from the repository, so this file cannot
//! be ported without them. They are modelled as the
//! [`DelegationDispatcherPort`] and [`ActionLedgerPort`] seams (OP-S9-7) instead
//! of being stubbed: the P3/P4 packages implement them, and the orchestrator then
//! has exactly the shape of the source.
//!
//! `buildIdempotencyKey` is a pure function, but it lives in
//! `execution/idempotency.ts` (P4). So that the orchestrator keeps the source's
//! call site it is hosted as [`ActionLedgerPort::build_idempotency_key`], with
//! its contract written out on the method — `sha256(actionPayload)` in lower-case
//! hex, truncated to 16 characters, joined as `runId:stepId:actionType:hash`.
//!
//! # `executeExactlyOnce<T>` becomes a `serde_json::Value` at the seam
//!
//! The ledger persists `resultPayload` as a string
//! (`MasterActionLedgerEntry.resultPayload`, `types.ts:22`), so the JSON value is
//! the natural currency and keeps [`ActionLedgerPort`] object-safe. The
//! orchestrator returns the outcome unchanged and the caller decodes it.
//!
//! # The publisher is injected
//!
//! `advanceRun` calls `publishMasterUpdated` (`orchestrator.ts:47-51`) while
//! `applyApprovalDecision` deliberately does not; both behaviours are kept. The
//! bus is the injected [`MasterEventPublisher`] of [`crate::master::live_events`].

use serde_json::Value;

use crate::master::lifecycle::{
    assert_transition, next_lifecycle_status, LifecycleOptions, MasterLifecycleError,
};
use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, MasterInvalidationResource,
    NoopMasterEventPublisher, PublishMasterUpdatedInput,
};
use crate::master::repository::runs_store::RunPatch;
use crate::master::repository::MasterRepository;
use crate::master::types::{ApprovalDecision, MasterRun, MasterRunStatus, WorkspaceScope};

/// `resources: ['runs', 'metrics', 'run_detail']` — `orchestrator.ts:49`.
pub const ADVANCE_RUN_RESOURCES: &[MasterInvalidationResource] = &[
    MasterInvalidationResource::Runs,
    MasterInvalidationResource::Metrics,
    MasterInvalidationResource::RunDetail,
];

/// The default publisher, used when no bus is injected.
static NOOP_PUBLISHER: NoopMasterEventPublisher = NoopMasterEventPublisher;

/// `task: () => Promise<{ output: string; confidence?: number }>` —
/// `orchestrator.ts:83`.
#[derive(Debug, Clone, PartialEq)]
pub struct DelegationTaskResult {
    pub output: String,
    /// `confidence?`.
    pub confidence: Option<f64>,
}

/// The object `dispatcher.dispatch` receives — `orchestrator.ts:86-92`.
///
/// The `task` closure is passed separately to
/// [`DelegationDispatcherPort::dispatch`] so the input struct stays cloneable and
/// the closure keeps its `FnOnce` ownership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationDispatchInput<'a> {
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub capability: &'a str,
    pub payload: &'a str,
}

/// `{ jobId: string; accepted: boolean; reason?: string }` —
/// `orchestrator.ts:85`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationDispatchOutcome {
    pub job_id: String,
    pub accepted: bool,
    pub reason: Option<String>,
}

/// `input` of `delegate` — `orchestrator.ts:80-84`.
pub struct DelegateInput<'a> {
    pub capability: &'a str,
    pub payload: &'a str,
    pub task: Box<dyn FnOnce() -> DelegationTaskResult + 'a>,
}

/// Seam for `master/delegation/dispatcher.ts` (package P3).
pub trait DelegationDispatcherPort {
    /// `dispatch(input)` — `dispatcher.ts`.
    fn dispatch(
        &self,
        input: &DelegationDispatchInput<'_>,
        task: Box<dyn FnOnce() -> DelegationTaskResult + '_>,
    ) -> DelegationDispatchOutcome;
}

/// The four fields of `buildIdempotencyKey` — `idempotency.ts:3-8`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildIdempotencyKeyInput<'a> {
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action_type: &'a str,
    pub action_payload: &'a str,
}

/// `input` of `ledger.executeExactlyOnce` — `actionLedger.ts`.
pub struct ExecuteExactlyOnceInput<'a> {
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action_type: &'a str,
    pub idempotency_key: &'a str,
    pub execute: Box<dyn FnOnce() -> Value + 'a>,
}

/// `{ replayed: boolean; result: T }` — `orchestrator.ts:102`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecuteExactlyOnceOutcome {
    pub replayed: bool,
    pub result: Value,
}

/// Seam for `master/execution/{actionLedger,idempotency}.ts` (package P4).
pub trait ActionLedgerPort {
    /// `buildIdempotencyKey` — `idempotency.ts:3-15`.
    ///
    /// Must be `sha256(actionPayload)` as lower-case hex, truncated to its first
    /// 16 characters, joined as `runId:stepId:actionType:hash` — the exact
    /// composition of the source, which the orchestrator's idempotency key
    /// depends on.
    fn build_idempotency_key(&self, input: &BuildIdempotencyKeyInput<'_>) -> String;

    /// `executeExactlyOnce` — `execution/actionLedger.ts`.
    fn execute_exactly_once(&self, input: ExecuteExactlyOnceInput<'_>)
        -> ExecuteExactlyOnceOutcome;
}

/// `Master run not found.` — `orchestrator.ts:33`.
///
/// The source also relies on the non-null assertions at `:46,64,70`: an update of
/// a missing run would silently return `undefined`. The port answers
/// [`MasterOrchestratorError::RunNotFound`] instead of inventing a run.
#[derive(Debug, thiserror::Error)]
pub enum MasterOrchestratorError {
    #[error("Master run not found.")]
    RunNotFound,
    #[error("Master run status \"{status}\" is not a known MasterRunStatus.")]
    UnknownRunStatus { status: String },
    #[error(transparent)]
    Lifecycle(#[from] MasterLifecycleError),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

/// `options` of `advanceRun` — `orchestrator.ts:25-30`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AdvanceRunOptions {
    pub verification_passed: Option<bool>,
    pub needs_approval: Option<bool>,
    pub failed: Option<bool>,
    pub progress: Option<i64>,
}

impl AdvanceRunOptions {
    /// The three flags `nextLifecycleStatus` reads. `progress` is deliberately
    /// not part of it: the source passes the whole options object and only
    /// `nextLifecycleStatus` ignores the extra key.
    fn lifecycle(&self) -> LifecycleOptions {
        LifecycleOptions {
            verification_passed: self.verification_passed,
            needs_approval: self.needs_approval,
            failed: self.failed,
            cancelled: None,
        }
    }
}

/// `input` of `applyApprovalDecision` — `orchestrator.ts:58`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDecisionInput {
    pub action_type: String,
    pub fingerprint: String,
    pub decision: ApprovalDecision,
}

/// `MasterOrchestrator` from `orchestrator.ts:9-117`.
pub struct MasterOrchestrator<'a> {
    repo: &'a dyn MasterRepository,
    dispatcher: &'a dyn DelegationDispatcherPort,
    ledger: &'a dyn ActionLedgerPort,
    publisher: &'a dyn MasterEventPublisher,
}

impl<'a> MasterOrchestrator<'a> {
    /// `constructor(repo)` — `orchestrator.ts:13-16`.
    ///
    /// The source constructs the dispatcher and the ledger from the repository;
    /// the port receives them, because both are later packages.
    pub fn new(
        repo: &'a dyn MasterRepository,
        dispatcher: &'a dyn DelegationDispatcherPort,
        ledger: &'a dyn ActionLedgerPort,
    ) -> Self {
        Self {
            repo,
            dispatcher,
            ledger,
            publisher: &NOOP_PUBLISHER,
        }
    }

    /// The same, with the event bus supplied.
    pub fn with_publisher(mut self, publisher: &'a dyn MasterEventPublisher) -> Self {
        self.publisher = publisher;
        self
    }

    /// `getRun` — `orchestrator.ts:18-20`.
    pub fn get_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> rusqlite::Result<Option<MasterRun>> {
        self.repo.get_run(scope, run_id)
    }

    /// `advanceRun` — `orchestrator.ts:22-53`.
    ///
    /// `Math.min(100, Math.max(0, options?.progress ?? run.progress + (next ===
    /// 'COMPLETED' ? 100 : 15)))` is reproduced with an explicit clamp, and the
    /// transition is only asserted when the status actually changes.
    pub fn advance_run(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        options: &AdvanceRunOptions,
    ) -> Result<MasterRun, MasterOrchestratorError> {
        let run = self
            .repo
            .get_run(scope, run_id)?
            .ok_or(MasterOrchestratorError::RunNotFound)?;
        let current = MasterRunStatus::parse(&run.status).ok_or_else(|| {
            MasterOrchestratorError::UnknownRunStatus {
                status: run.status.clone(),
            }
        })?;
        let next = next_lifecycle_status(current, &options.lifecycle());
        if next != current {
            assert_transition(current, next)?;
        }
        let default_progress = run.progress
            + if next == MasterRunStatus::Completed {
                100
            } else {
                15
            };
        let progress = options.progress.unwrap_or(default_progress).clamp(0, 100);
        let updated = self
            .repo
            .update_run(
                scope,
                run_id,
                &RunPatch {
                    status: Some(next.as_str().to_string()),
                    progress: Some(progress),
                    paused_for_approval: Some(next == MasterRunStatus::AwaitingApproval),
                    ..RunPatch::default()
                },
            )?
            .ok_or(MasterOrchestratorError::RunNotFound)?;
        publish_master_updated(
            self.publisher,
            &PublishMasterUpdatedInput {
                scope: scope.clone(),
                resources: ADVANCE_RUN_RESOURCES.to_vec(),
                run_id: Some(run_id.to_string()),
                approval_request_id: None,
                session_id: None,
                reminder_id: None,
            },
        );
        Ok(updated)
    }

    /// `applyApprovalDecision` — `orchestrator.ts:55-75`.
    ///
    /// An `approve_always` decision first records the standing rule; `deny`
    /// returns the run to `REFINING` with the source's exact error text, and
    /// everything else (including `approve_once`) resumes `EXECUTING` and clears
    /// `lastError`. No invalidation is published here — the source does not.
    pub fn apply_approval_decision(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        input: &ApprovalDecisionInput,
    ) -> Result<MasterRun, MasterOrchestratorError> {
        if input.decision == ApprovalDecision::ApproveAlways {
            self.repo.upsert_approval_rule(
                scope,
                &input.action_type,
                &input.fingerprint,
                ApprovalDecision::ApproveAlways.as_str(),
            )?;
        }
        let patch = if input.decision == ApprovalDecision::Deny {
            RunPatch {
                status: Some(MasterRunStatus::Refining.as_str().to_string()),
                paused_for_approval: Some(false),
                last_error: Some(Some(format!("Action denied: {}", input.action_type))),
                ..RunPatch::default()
            }
        } else {
            RunPatch {
                status: Some(MasterRunStatus::Executing.as_str().to_string()),
                paused_for_approval: Some(false),
                last_error: Some(None),
                ..RunPatch::default()
            }
        };
        self.repo
            .update_run(scope, run_id, &patch)?
            .ok_or(MasterOrchestratorError::RunNotFound)
    }

    /// `delegate` — `orchestrator.ts:77-93`.
    pub fn delegate(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        input: DelegateInput<'_>,
    ) -> DelegationDispatchOutcome {
        self.dispatcher.dispatch(
            &DelegationDispatchInput {
                scope,
                run_id,
                capability: input.capability,
                payload: input.payload,
            },
            input.task,
        )
    }

    /// `executeSideEffect` — `orchestrator.ts:95-117`.
    ///
    /// The idempotency key is built from `{ runId, stepId, actionType,
    /// actionPayload }` — the four fields of `buildIdempotencyKey` — and handed
    /// to the ledger unchanged.
    pub fn execute_side_effect(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        step_id: &str,
        action_type: &str,
        action_payload: &str,
        execute: Box<dyn FnOnce() -> Value + '_>,
    ) -> ExecuteExactlyOnceOutcome {
        let idempotency_key = self
            .ledger
            .build_idempotency_key(&BuildIdempotencyKeyInput {
                run_id,
                step_id,
                action_type,
                action_payload,
            });
        self.ledger.execute_exactly_once(ExecuteExactlyOnceInput {
            scope,
            run_id,
            step_id,
            action_type,
            idempotency_key: &idempotency_key,
            execute,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::master::live_events::MasterUpdatedEvent;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::MasterRunCreateInput;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[derive(Default)]
    struct RecordingPublisher {
        events: Mutex<Vec<MasterUpdatedEvent>>,
    }

    impl MasterEventPublisher for RecordingPublisher {
        fn publish_master_updated(&self, event: &MasterUpdatedEvent) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    #[derive(Default)]
    struct FakeDispatcher {
        dispatched: Mutex<Vec<String>>,
    }

    impl DelegationDispatcherPort for FakeDispatcher {
        fn dispatch(
            &self,
            input: &DelegationDispatchInput<'_>,
            task: Box<dyn FnOnce() -> DelegationTaskResult + '_>,
        ) -> DelegationDispatchOutcome {
            self.dispatched.lock().unwrap().push(format!(
                "{}|{}|{}|{}",
                input.scope.user_id, input.run_id, input.capability, input.payload
            ));
            let result = task();
            DelegationDispatchOutcome {
                job_id: format!("job-for-{}", result.output),
                accepted: result.confidence.is_some(),
                reason: result.confidence.map(|_| "confident".to_string()),
            }
        }
    }

    #[derive(Default)]
    struct FakeLedger {
        keys: Mutex<Vec<String>>,
    }

    impl ActionLedgerPort for FakeLedger {
        fn build_idempotency_key(&self, input: &BuildIdempotencyKeyInput<'_>) -> String {
            format!(
                "{}:{}:{}:hash({})",
                input.run_id, input.step_id, input.action_type, input.action_payload
            )
        }

        fn execute_exactly_once(
            &self,
            input: ExecuteExactlyOnceInput<'_>,
        ) -> ExecuteExactlyOnceOutcome {
            self.keys.lock().unwrap().push(format!(
                "{}|{}|{}",
                input.idempotency_key, input.step_id, input.action_type
            ));
            let result = (input.execute)();
            ExecuteExactlyOnceOutcome {
                replayed: false,
                result,
            }
        }
    }

    /// A run in `status`, created through the repository.
    fn run_at(repo: &SqliteMasterRepository, status: MasterRunStatus, progress: i64) -> String {
        let created = repo
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            })
            .unwrap();
        repo.update_run(
            &scope(),
            &created.id,
            &RunPatch {
                status: Some(status.as_str().to_string()),
                progress: Some(progress),
                ..RunPatch::default()
            },
        )
        .unwrap();
        created.id
    }

    #[test]
    fn advancing_a_run_moves_one_step_writes_and_publishes() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Analyzing, 10);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let publisher = RecordingPublisher::default();
        let orchestrator =
            MasterOrchestrator::new(&repo, &dispatcher, &ledger).with_publisher(&publisher);

        let updated = orchestrator
            .advance_run(&scope(), &run_id, &AdvanceRunOptions::default())
            .unwrap();
        assert_eq!(updated.status, "PLANNING");
        // 10 + 15, clamped into 0..=100.
        assert_eq!(updated.progress, 25);
        assert!(!updated.paused_for_approval);

        let events = publisher.events.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].resources, ADVANCE_RUN_RESOURCES.to_vec());
        assert_eq!(events[0].run_id, Some(run_id));
    }

    #[test]
    fn an_unknown_run_is_reported_not_invented() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let error = orchestrator
            .advance_run(&scope(), "missing", &AdvanceRunOptions::default())
            .unwrap_err();
        assert_eq!(error.to_string(), "Master run not found.");
        assert!(orchestrator.get_run(&scope(), "missing").unwrap().is_none());
    }

    #[test]
    fn an_invalid_transition_is_refused_with_the_source_message() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Completed, 100);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let error = orchestrator
            .advance_run(
                &scope(),
                &run_id,
                &AdvanceRunOptions {
                    needs_approval: Some(true),
                    ..AdvanceRunOptions::default()
                },
            )
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid master run transition: COMPLETED -> AWAITING_APPROVAL"
        );
        // The run is untouched.
        let run = repo.get_run(&scope(), &run_id).unwrap().unwrap();
        assert_eq!(run.status, "COMPLETED");
    }

    #[test]
    fn a_verification_pass_completes_the_run_and_clamps_the_progress() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Verifying, 90);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let updated = orchestrator
            .advance_run(
                &scope(),
                &run_id,
                &AdvanceRunOptions {
                    verification_passed: Some(true),
                    ..AdvanceRunOptions::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, "COMPLETED");
        // 90 + 100 clamps to 100 rather than 190.
        assert_eq!(updated.progress, 100);
    }

    #[test]
    fn needs_approval_pauses_the_run_and_an_explicit_progress_wins() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Executing, 20);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let updated = orchestrator
            .advance_run(
                &scope(),
                &run_id,
                &AdvanceRunOptions {
                    needs_approval: Some(true),
                    progress: Some(150),
                    ..AdvanceRunOptions::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, "AWAITING_APPROVAL");
        assert!(updated.paused_for_approval);
        assert_eq!(updated.progress, 100);
    }

    #[test]
    fn a_denied_approval_returns_the_run_to_refining_with_the_source_text() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::AwaitingApproval, 40);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let publisher = RecordingPublisher::default();
        let orchestrator =
            MasterOrchestrator::new(&repo, &dispatcher, &ledger).with_publisher(&publisher);

        let updated = orchestrator
            .apply_approval_decision(
                &scope(),
                &run_id,
                &ApprovalDecisionInput {
                    action_type: "exec".to_string(),
                    fingerprint: "fp".to_string(),
                    decision: ApprovalDecision::Deny,
                },
            )
            .unwrap();
        assert_eq!(updated.status, "REFINING");
        assert!(!updated.paused_for_approval);
        assert_eq!(updated.last_error, Some("Action denied: exec".to_string()));
        // The source publishes nothing on this path.
        assert!(publisher.events.lock().unwrap().is_empty());
    }

    #[test]
    fn an_approval_resumes_executing_and_approve_always_records_the_rule() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::AwaitingApproval, 40);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let approved = orchestrator
            .apply_approval_decision(
                &scope(),
                &run_id,
                &ApprovalDecisionInput {
                    action_type: "exec".to_string(),
                    fingerprint: "fp".to_string(),
                    decision: ApprovalDecision::ApproveOnce,
                },
            )
            .unwrap();
        assert_eq!(approved.status, "EXECUTING");
        assert_eq!(approved.last_error, None);
        assert!(repo
            .get_approval_rule(&scope(), "exec", "fp")
            .unwrap()
            .is_none());

        orchestrator
            .apply_approval_decision(
                &scope(),
                &run_id,
                &ApprovalDecisionInput {
                    action_type: "exec".to_string(),
                    fingerprint: "fp".to_string(),
                    decision: ApprovalDecision::ApproveAlways,
                },
            )
            .unwrap();
        assert_eq!(
            repo.get_approval_rule(&scope(), "exec", "fp")
                .unwrap()
                .as_deref(),
            Some("approve_always")
        );
    }

    #[test]
    fn delegate_forwards_the_run_and_the_task_to_the_dispatcher() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Delegating, 30);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let capability = "cap".to_string();
        let payload = "{\"a\":1}".to_string();
        let outcome = orchestrator.delegate(
            &scope(),
            &run_id,
            DelegateInput {
                capability: &capability,
                payload: &payload,
                task: Box::new(|| DelegationTaskResult {
                    output: "done".to_string(),
                    confidence: Some(0.8),
                }),
            },
        );
        assert!(outcome.accepted);
        assert_eq!(outcome.job_id, "job-for-done");
        assert_eq!(outcome.reason.as_deref(), Some("confident"));
        assert_eq!(
            dispatcher.dispatched.lock().unwrap().as_slice(),
            &[format!("u1|{}|cap|{{\"a\":1}}", run_id)]
        );
    }

    #[test]
    fn a_side_effect_gets_the_key_built_from_the_four_source_fields() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let run_id = run_at(&repo, MasterRunStatus::Executing, 50);
        let dispatcher = FakeDispatcher::default();
        let ledger = FakeLedger::default();
        let orchestrator = MasterOrchestrator::new(&repo, &dispatcher, &ledger);

        let outcome = orchestrator.execute_side_effect(
            &scope(),
            &run_id,
            "step-1",
            "gmail.send",
            "{\"to\":\"x\"}",
            Box::new(|| serde_json::json!({ "sent": true })),
        );
        assert!(!outcome.replayed);
        assert_eq!(outcome.result, serde_json::json!({ "sent": true }));
        assert_eq!(
            ledger.keys.lock().unwrap().as_slice(),
            &[format!(
                "{}:step-1:gmail.send:hash({{\"to\":\"x\"}})|step-1|gmail.send",
                run_id
            )]
        );
    }
}
