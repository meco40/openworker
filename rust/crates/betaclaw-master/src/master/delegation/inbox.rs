//! Port of `src/server/master/delegation/inbox.ts:1-22`.
//!
//! A one-method adapter that serialises an arbitrary payload and routes it
//! through [`super::session_service::publish_delegation_event`], so an inbox
//! write also refreshes the paired session's `latestEventAt`. `type` is the
//! `'progress' | 'result' | 'error'` union; the port keeps it as `&str` because
//! the event column stores the raw text.

use serde_json::Value;

use crate::master::repository::delegation_store::MasterDelegationEventInput;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterDelegationEvent, WorkspaceScope};

use super::session_service::publish_delegation_event;

/// `DelegationInbox` from `inbox.ts:5-21`.
pub struct DelegationInbox<'a> {
    repo: &'a dyn MasterRepository,
}

impl<'a> DelegationInbox<'a> {
    /// `constructor(private readonly repo)` — `inbox.ts:6`.
    pub fn new(repo: &'a dyn MasterRepository) -> Self {
        Self { repo }
    }

    /// `publish` — `inbox.ts:8-21`.
    ///
    /// `JSON.stringify(payload)` is [`Value::to_string`]; a `Value` that cannot
    /// exist (always serialisable) is impossible here.
    pub fn publish(
        &self,
        scope: &WorkspaceScope,
        run_id: &str,
        job_id: &str,
        event_type: &str,
        payload: &Value,
    ) -> rusqlite::Result<MasterDelegationEvent> {
        publish_delegation_event(
            self.repo,
            scope,
            &MasterDelegationEventInput {
                run_id: run_id.to_string(),
                job_id: job_id.to_string(),
                event_type: event_type.to_string(),
                payload: payload.to_string(),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn publish_serialises_the_payload() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let inbox = DelegationInbox::new(&repo);
        let event = inbox
            .publish(
                &scope(),
                "run-1",
                "job-1",
                "progress",
                &serde_json::json!({ "stage": "running" }),
            )
            .unwrap();
        assert_eq!(event.event_type, "progress");
        assert_eq!(event.payload, "{\"stage\":\"running\"}");
        assert_eq!(
            repo.list_delegation_events(&scope(), "run-1")
                .unwrap()
                .len(),
            1
        );
    }
}
