//! Port of `src/server/master/delegation/subagentPool.ts:1-106`.
//!
//! The executor of one delegated job: claim the session, mark the job `running`,
//! run the caller-supplied task, then complete (or cancel) the session and the
//! job and publish the matching events.
//!
//! # The interval timer is a seam
//!
//! `setInterval(syncHeartbeat, heartbeatIntervalMs)` with `heartbeatTimer.unref()`
//! (`subagentPool.ts:59-61`) is a process-wide timer. `betaclaw-core` cannot own
//! one, so the periodic re-sync is the [`SubagentHeartbeatScheduler`] seam and
//! the default [`NoopSubagentHeartbeatScheduler`] only logs — the same
//! fire-and-forget treatment [`crate::master::runtime`] gives the maintenance
//! timer. The one deterministic sync before the task and the `cancel` in the
//! `finally` are executed here; only the repeated ticks are delegated (OP-S9-11).
//!
//! # The task closure is infallible here
//!
//! `task: () => Promise<{ output, confidence? }>` can reject in TypeScript and
//! the source then marks the job `failed` and re-throws
//! (`subagentPool.ts:78-99`). The [`crate::master::orchestrator::DelegationDispatcherPort`]
//! seam types the closure as `FnOnce() -> DelegationTaskResult`, so a Rust task
//! cannot fail; the failure branch is kept at the job level only for repository
//! errors, and the difference is recorded as OP-S9-11.

use serde_json::{json, Value};

use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, MasterInvalidationResource,
    PublishMasterUpdatedInput,
};
use crate::master::orchestrator::DelegationTaskResult;
use crate::master::repository::delegation_store::DelegationPatch;
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

use super::inbox::DelegationInbox;
use super::session_service::{
    claim_subagent_session, complete_subagent_session, sync_subagent_session_heartbeat,
    ClaimSubagentSessionRequest, SyncSubagentSessionHeartbeatInput,
};

/// `30_000` — `subagentPool.ts:38`.
pub const DEFAULT_POOL_LEASE_MS: i64 = 30_000;

/// `10_000` — `subagentPool.ts:39`.
pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 10_000;

/// `SubagentPoolOptions` from `subagentPool.ts:8-11`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SubagentPoolOptions {
    pub heartbeat_interval_ms: Option<u64>,
    pub lease_ms: Option<i64>,
}

/// `setInterval(…, heartbeatIntervalMs)` / `clearInterval(handle)`.
///
/// The production timer lives in the gateway; the default never ticks, exactly
/// like the no-op maintenance scheduler.
pub trait SubagentHeartbeatScheduler: Send + Sync {
    /// `setInterval(syncHeartbeat, heartbeatIntervalMs)`.
    fn schedule(&self, interval_ms: u64);
    /// `clearInterval(heartbeatTimer)`.
    fn cancel(&self);
}

/// The default: log and continue.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopSubagentHeartbeatScheduler;

impl SubagentHeartbeatScheduler for NoopSubagentHeartbeatScheduler {
    fn schedule(&self, interval_ms: u64) {
        tracing::debug!(interval_ms, "subagent heartbeat scheduled (no timer)");
    }

    fn cancel(&self) {
        tracing::debug!("subagent heartbeat cancelled");
    }
}

/// `JSON.stringify(result)` for the `result` inbox event.
///
/// `confidence?` is omitted when absent, matching JavaScript object
/// serialisation; `output` is always present.
fn result_payload(result: &DelegationTaskResult) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("output".to_string(), Value::String(result.output.clone()));
    if let Some(confidence) = result.confidence {
        map.insert(
            "confidence".to_string(),
            serde_json::Number::from_f64(confidence)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
    }
    Value::Object(map)
}

/// `SubagentPool` from `subagentPool.ts:13-106`.
pub struct SubagentPool<'a> {
    repo: &'a dyn MasterRepository,
    inbox: &'a DelegationInbox<'a>,
    publisher: &'a dyn MasterEventPublisher,
    heartbeat: &'a dyn SubagentHeartbeatScheduler,
    /// `` `subagent-pool:${process.pid}` `` — `subagentPool.ts:14`.
    owner_id: String,
    options: SubagentPoolOptions,
}

impl<'a> SubagentPool<'a> {
    /// `constructor(repo, inbox, options)` — `subagentPool.ts:16-20`.
    pub fn new(
        repo: &'a dyn MasterRepository,
        inbox: &'a DelegationInbox<'a>,
        publisher: &'a dyn MasterEventPublisher,
        heartbeat: &'a dyn SubagentHeartbeatScheduler,
        options: SubagentPoolOptions,
    ) -> Self {
        Self {
            repo,
            inbox,
            publisher,
            heartbeat,
            owner_id: format!("subagent-pool:{}", std::process::id()),
            options,
        }
    }

    /// The `ownerId` a claim and heartbeat carry — `subagentPool.ts:14`.
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }

    fn publish_state(&self, scope: &WorkspaceScope, run_id: &str, session_id: Option<&str>) {
        let resources = if session_id.is_some() {
            vec![
                MasterInvalidationResource::Subagents,
                MasterInvalidationResource::Metrics,
            ]
        } else {
            vec![MasterInvalidationResource::Metrics]
        };
        publish_master_updated(
            self.publisher,
            &PublishMasterUpdatedInput {
                scope: scope.clone(),
                resources,
                run_id: Some(run_id.to_string()),
                approval_request_id: None,
                session_id: session_id.map(str::to_string),
                reminder_id: None,
            },
        );
    }

    /// `execute` — `subagentPool.ts:22-105`.
    pub fn execute(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        job_id: &str,
        session_id: Option<&str>,
        task: Box<dyn FnOnce() -> DelegationTaskResult + '_>,
    ) -> rusqlite::Result<()> {
        let lease_ms = self.options.lease_ms.unwrap_or(DEFAULT_POOL_LEASE_MS);
        let heartbeat_interval_ms = self
            .options
            .heartbeat_interval_ms
            .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_MS);

        if let Some(session_id) = session_id {
            claim_subagent_session(
                self.repo,
                scope,
                session_id,
                &ClaimSubagentSessionRequest {
                    owner_id: &self.owner_id,
                    now: None,
                    lease_ms: Some(lease_ms),
                },
                self.publisher,
            )?;
        }
        self.repo.update_delegation_job(
            scope,
            job_id,
            &DelegationPatch {
                status: Some("running".to_string()),
                ..DelegationPatch::default()
            },
        )?;
        self.publish_state(scope, run_id, session_id);
        self.inbox.publish(
            scope,
            run_id,
            job_id,
            "progress",
            &json!({ "stage": "running" }),
        )?;

        let mut scheduled = false;
        if let Some(session_id) = session_id {
            sync_subagent_session_heartbeat(
                self.repo,
                scope,
                session_id,
                &SyncSubagentSessionHeartbeatInput {
                    owner_id: &self.owner_id,
                    now: None,
                    lease_ms: Some(lease_ms),
                },
            )?;
            self.heartbeat.schedule(heartbeat_interval_ms);
            scheduled = true;
        }

        let result = task();
        let session = match session_id {
            Some(session_id) => self.repo.get_subagent_session(scope, session_id)?,
            None => None,
        };
        if session.as_ref().map(|session| session.status.as_str()) == Some("cancelled") {
            self.repo.update_delegation_job(
                scope,
                job_id,
                &DelegationPatch {
                    status: Some("cancelled".to_string()),
                    ..DelegationPatch::default()
                },
            )?;
            self.publish_state(scope, run_id, session_id);
            if scheduled {
                self.heartbeat.cancel();
            }
            return Ok(());
        }

        self.repo.update_delegation_job(
            scope,
            job_id,
            &DelegationPatch {
                status: Some("completed".to_string()),
                ..DelegationPatch::default()
            },
        )?;
        self.publish_state(scope, run_id, session_id);
        self.inbox
            .publish(scope, run_id, job_id, "result", &result_payload(&result))?;
        if let Some(session_id) = session_id {
            complete_subagent_session(
                self.repo,
                scope,
                session_id,
                &result.output,
                None,
                self.publisher,
            )?;
        }
        if scheduled {
            self.heartbeat.cancel();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::master::delegation::session_service::CreateSubagentSessionForDispatchInput;
    use crate::master::live_events::{MasterUpdatedEvent, NoopMasterEventPublisher};
    use crate::master::repository::delegation_store::MasterDelegationJobInput;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::MasterRunCreateInput;

    #[derive(Default)]
    struct RecordingHeartbeat {
        scheduled: AtomicUsize,
        cancelled: AtomicUsize,
    }

    impl SubagentHeartbeatScheduler for RecordingHeartbeat {
        fn schedule(&self, _interval_ms: u64) {
            self.scheduled.fetch_add(1, Ordering::SeqCst);
        }

        fn cancel(&self) {
            self.cancelled.fetch_add(1, Ordering::SeqCst);
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

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn execute_completes_the_job_and_the_session() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = repo
            .create_run(&MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "Run".to_string(),
                contract: "Contract".to_string(),
            })
            .unwrap()
            .id;
        let session =
            crate::master::delegation::session_service::create_subagent_session_for_dispatch(
                &repo,
                &scope,
                &CreateSubagentSessionForDispatchInput {
                    run_id: run_id.clone(),
                    capability: "web_search".to_string(),
                    payload: "Find docs".to_string(),
                    assigned_tools: None,
                },
                &NoopMasterEventPublisher,
            )
            .unwrap();
        let job = repo
            .create_delegation_job(
                &scope,
                &MasterDelegationJobInput {
                    run_id: run_id.clone(),
                    capability: "web_search".to_string(),
                    payload: "{}".to_string(),
                    status: "queued".to_string(),
                    priority: "medium".to_string(),
                    max_attempts: 3,
                    timeout_ms: 120_000,
                },
            )
            .unwrap();

        let publisher = RecordingPublisher::default();
        let heartbeat = RecordingHeartbeat::default();
        let inbox = DelegationInbox::new(&repo);
        let pool = SubagentPool::new(
            &repo,
            &inbox,
            &publisher,
            &heartbeat,
            SubagentPoolOptions::default(),
        );
        pool.execute(
            &scope,
            &run_id,
            &job.id,
            Some(&session.id),
            Box::new(|| DelegationTaskResult {
                output: "result body".to_string(),
                confidence: Some(0.8),
            }),
        )
        .unwrap();

        let jobs = repo.list_delegation_jobs(&scope, &run_id).unwrap();
        assert_eq!(jobs[0].status, "completed");
        let sessions = repo
            .list_subagent_sessions(&scope, Some(&run_id), 100)
            .unwrap();
        assert_eq!(sessions[0].status, "completed");
        assert_eq!(sessions[0].result_summary.as_deref(), Some("result body"));
        let events = repo.list_delegation_events(&scope, &run_id).unwrap();
        assert!(events.iter().any(|event| event.event_type == "result"));
        assert_eq!(heartbeat.scheduled.load(Ordering::SeqCst), 1);
        assert_eq!(heartbeat.cancelled.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn result_payload_omits_an_absent_confidence() {
        let with = result_payload(&DelegationTaskResult {
            output: "x".to_string(),
            confidence: Some(0.5),
        });
        assert_eq!(
            with,
            serde_json::json!({ "output": "x", "confidence": 0.5 })
        );
        let without = result_payload(&DelegationTaskResult {
            output: "x".to_string(),
            confidence: None,
        });
        assert_eq!(without, serde_json::json!({ "output": "x" }));
    }
}
