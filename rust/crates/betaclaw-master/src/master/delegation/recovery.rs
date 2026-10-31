//! Port of `src/server/master/delegation/recovery.ts:1-27`.
//!
//! On startup one scope's `running` jobs are returned to `queued` with their
//! attempt counter bumped; each one also gets a `progress` event carrying
//! `{"recovered":true}`. `recoverDelegationQueue` returns the number it moved,
//! which is what a caller reports.

use crate::master::repository::delegation_store::{DelegationPatch, MasterDelegationEventInput};
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

/// `recoverDelegationQueue` — `recovery.ts:5-27`.
pub fn recover_delegation_queue(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<usize> {
    let jobs = repo.list_delegation_jobs(scope, run_id)?;
    let mut recovered = 0usize;
    for job in jobs {
        if job.status == "running" {
            repo.update_delegation_job(
                scope,
                &job.id,
                &DelegationPatch {
                    status: Some("queued".to_string()),
                    attempts: Some(job.attempts + 1),
                    ..DelegationPatch::default()
                },
            )?;
            repo.append_delegation_event(
                scope,
                &MasterDelegationEventInput {
                    run_id: run_id.to_string(),
                    job_id: job.id.clone(),
                    event_type: "progress".to_string(),
                    payload: serde_json::json!({ "recovered": true }).to_string(),
                },
            )?;
            recovered += 1;
        }
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::delegation_store::MasterDelegationJobInput;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn job(repo: &SqliteMasterRepository, scope: &WorkspaceScope, status: &str) -> String {
        repo.create_delegation_job(
            scope,
            &MasterDelegationJobInput {
                run_id: "run-1".to_string(),
                capability: "web_search".to_string(),
                payload: "{}".to_string(),
                status: status.to_string(),
                priority: "medium".to_string(),
                max_attempts: 3,
                timeout_ms: 120_000,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn only_running_jobs_are_recovered() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let running = job(&repo, &scope, "running");
        let queued = job(&repo, &scope, "queued");

        assert_eq!(recover_delegation_queue(&repo, &scope, "run-1").unwrap(), 1);

        let jobs = repo.list_delegation_jobs(&scope, "run-1").unwrap();
        let recovered = jobs.iter().find(|entry| entry.id == running).unwrap();
        assert_eq!(recovered.status, "queued");
        assert_eq!(recovered.attempts, 1);
        let untouched = jobs.iter().find(|entry| entry.id == queued).unwrap();
        assert_eq!(untouched.attempts, 0);
        let events = repo.list_delegation_events(&scope, "run-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload, "{\"recovered\":true}");
    }
}
