//! Port of `src/server/master/approvals/service.ts:1-192`.
//!
//! Three functions over persisted approval requests:
//!
//! * [`create_pending_approval_request`] is idempotent for a
//!   `(scope, runId, actionType, fingerprint)` of a still-pending request and
//!   otherwise parks the run in `AWAITING_APPROVAL`, writes an audit event and
//!   publishes a `master.updated` invalidation.
//! * [`apply_approval_decision`] moves the request and the run in one step, and
//!   records a standing `approve_always` rule for the decided fingerprint.
//! * [`consume_approved_approval_request`] burns exactly one `approve_once`
//!   request so a runtime can run it once.
//!
//! # The ambient clock becomes a parameter
//!
//! `new Date()` / `new Date(Date.now() + TTL)` (`service.ts:66,109`) are the two
//! reads of the process clock. Both become an explicit `now: DateTime<Utc>`
//! argument, the same deviation [`crate::master::feature_flags`] documents for
//! the environment: pass in what the source read globally.
//!
//! # The event bus is the injected publisher
//!
//! `publishMasterUpdated` (`service.ts:80,150,184`) goes through the
//! [`MasterEventPublisher`] seam of [`crate::master::live_events`]; the three
//! call sites pass `['approvals', 'runs', 'metrics', 'run_detail']` verbatim.

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};

use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, MasterInvalidationResource,
    PublishMasterUpdatedInput,
};
use crate::master::repository::approvals_store::{ApprovalPatch, MasterApprovalRequestInput};
use crate::master::repository::audit_store::MasterAuditEventInput;
use crate::master::repository::runs_store::RunPatch;
use crate::master::repository::MasterRepository;
use crate::master::types::{ApprovalDecision, MasterApprovalRequest, WorkspaceScope};

/// `DEFAULT_APPROVAL_TTL_MS` — `service.ts:8` (`5 * 60 * 1000`).
pub const DEFAULT_APPROVAL_TTL_MS: i64 = 5 * 60 * 1000;

/// `listApprovalRequests` default from `approvals.store.ts:104` (`limit = 200`).
///
/// `service.ts:44,166` call it without a limit.
pub const LIST_APPROVAL_REQUESTS_LIMIT: i64 = 200;

/// The resources of the three `publishMasterUpdated` calls — `service.ts:82,…`.
pub const APPROVAL_RESOURCES: &[MasterInvalidationResource] = &[
    MasterInvalidationResource::Approvals,
    MasterInvalidationResource::Runs,
    MasterInvalidationResource::Metrics,
    MasterInvalidationResource::RunDetail,
];

/// The two `throw`s of `service.ts:112,122` plus the wrapped repository error.
#[derive(Debug, thiserror::Error)]
pub enum ApprovalServiceError {
    #[error("Approval request not found.")]
    RequestNotFound,
    #[error("Approval request could not be updated.")]
    RequestNotUpdatable,
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

fn expiry_iso(now: DateTime<Utc>, ttl_ms: i64) -> String {
    (now + ChronoDuration::milliseconds(ttl_ms)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `buildPrompt` from `service.ts:10-12`.
pub fn build_prompt(summary: &str, action_type: &str) -> String {
    format!("Approval required for {action_type}: {summary}")
}

/// `buildDecisionReason` from `service.ts:14-27`.
///
/// The TypeScript `default` branch is the `never` exhaustiveness guard; the Rust
/// match over [`ApprovalDecision`] has no such branch to reach.
pub fn build_decision_reason(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::ApproveAlways => "Approved and persisted for future matching actions.",
        ApprovalDecision::ApproveOnce => "Approved for a single matching action.",
        ApprovalDecision::Deny => "Action denied by operator.",
    }
}

/// `input` of `createPendingApprovalRequest` — `service.ts:29-45`.
pub struct CreatePendingApprovalRequestInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub run_id: &'a str,
    pub step_id: &'a str,
    pub action_type: &'a str,
    pub summary: &'a str,
    /// `host: MasterApprovalRequest['host']`.
    pub host: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub resolved_path: Option<&'a str>,
    pub fingerprint: &'a str,
    /// `riskLevel: MasterApprovalRequest['riskLevel']`.
    pub risk_level: &'a str,
    pub tool_name: Option<&'a str>,
    pub prompt: Option<&'a str>,
    pub expires_at: Option<&'a str>,
}

/// `createPendingApprovalRequest` — `service.ts:29-88`.
pub fn create_pending_approval_request(
    input: &CreatePendingApprovalRequestInput<'_>,
    publisher: &dyn MasterEventPublisher,
    now: DateTime<Utc>,
) -> Result<MasterApprovalRequest, ApprovalServiceError> {
    let existing = input
        .repo
        .list_approval_requests(
            input.scope,
            Some(input.run_id),
            LIST_APPROVAL_REQUESTS_LIMIT,
        )?
        .into_iter()
        .find(|request| {
            request.status == "pending"
                && request.action_type == input.action_type
                && request.fingerprint == input.fingerprint
        });
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let request = input.repo.create_approval_request(
        input.scope,
        &MasterApprovalRequestInput {
            run_id: input.run_id.to_string(),
            step_id: input.step_id.to_string(),
            tool_name: input.tool_name.unwrap_or(input.action_type).to_string(),
            action_type: input.action_type.to_string(),
            summary: input.summary.to_string(),
            prompt: input
                .prompt
                .map(str::to_string)
                .unwrap_or_else(|| build_prompt(input.summary, input.action_type)),
            host: input.host.map(str::to_string),
            cwd: input.cwd.map(str::to_string),
            resolved_path: input.resolved_path.map(str::to_string),
            fingerprint: input.fingerprint.to_string(),
            risk_level: input.risk_level.to_string(),
            status: "pending".to_string(),
            expires_at: input
                .expires_at
                .map(str::to_string)
                .unwrap_or_else(|| expiry_iso(now, DEFAULT_APPROVAL_TTL_MS)),
            decision: None,
            decision_reason: None,
            decided_at: None,
        },
    )?;

    input.repo.update_run(
        input.scope,
        input.run_id,
        &RunPatch {
            status: Some("AWAITING_APPROVAL".to_string()),
            paused_for_approval: Some(true),
            pending_approval_action_type: Some(Some(input.action_type.to_string())),
            last_error: Some(Some(request.prompt.clone())),
            ..RunPatch::default()
        },
    )?;
    input.repo.append_audit_event(
        input.scope,
        &MasterAuditEventInput {
            category: "approval".to_string(),
            action: "request_created".to_string(),
            metadata: serde_json::json!({
                "requestId": request.id,
                "runId": input.run_id,
                "actionType": input.action_type,
                "fingerprint": input.fingerprint,
            })
            .to_string(),
        },
    )?;
    publish_master_updated(
        publisher,
        &PublishMasterUpdatedInput {
            scope: input.scope.clone(),
            resources: APPROVAL_RESOURCES.to_vec(),
            run_id: Some(input.run_id.to_string()),
            approval_request_id: Some(request.id.clone()),
            session_id: None,
            reminder_id: None,
        },
    );
    Ok(request)
}

/// `input` of `applyApprovalDecision` — `service.ts:90-95`.
pub struct ApplyApprovalDecisionInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub request_id: &'a str,
    pub decision: ApprovalDecision,
}

/// `applyApprovalDecision` — `service.ts:90-158`.
pub fn apply_approval_decision(
    input: &ApplyApprovalDecisionInput<'_>,
    publisher: &dyn MasterEventPublisher,
    now: DateTime<Utc>,
) -> Result<MasterApprovalRequest, ApprovalServiceError> {
    let request = input
        .repo
        .get_approval_request(input.scope, input.request_id)?
        .ok_or(ApprovalServiceError::RequestNotFound)?;

    let decided_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let status = if input.decision == ApprovalDecision::Deny {
        "denied"
    } else {
        "approved"
    };
    let updated = input
        .repo
        .update_approval_request(
            input.scope,
            input.request_id,
            &ApprovalPatch {
                status: Some(status.to_string()),
                decision: Some(Some(input.decision.as_str().to_string())),
                decision_reason: Some(Some(build_decision_reason(input.decision).to_string())),
                decided_at: Some(Some(decided_at)),
                ..ApprovalPatch::default()
            },
        )?
        .ok_or(ApprovalServiceError::RequestNotUpdatable)?;

    if input.decision == ApprovalDecision::ApproveAlways {
        input.repo.upsert_approval_rule(
            input.scope,
            &updated.action_type,
            &updated.fingerprint,
            ApprovalDecision::ApproveAlways.as_str(),
        )?;
    }

    input.repo.update_run(
        input.scope,
        &request.run_id,
        &RunPatch {
            status: Some(
                if input.decision == ApprovalDecision::Deny {
                    "REFINING"
                } else {
                    "EXECUTING"
                }
                .to_string(),
            ),
            paused_for_approval: Some(false),
            pending_approval_action_type: Some(None),
            last_error: Some(if input.decision == ApprovalDecision::Deny {
                Some(format!("Action denied: {}", updated.action_type))
            } else {
                None
            }),
            ..RunPatch::default()
        },
    )?;
    input.repo.append_audit_event(
        input.scope,
        &MasterAuditEventInput {
            category: "approval".to_string(),
            action: "decision_applied".to_string(),
            metadata: serde_json::json!({
                "requestId": updated.id,
                "runId": updated.run_id,
                "actionType": updated.action_type,
                "decision": input.decision.as_str(),
            })
            .to_string(),
        },
    )?;
    publish_master_updated(
        publisher,
        &PublishMasterUpdatedInput {
            scope: input.scope.clone(),
            resources: APPROVAL_RESOURCES.to_vec(),
            run_id: Some(updated.run_id.clone()),
            approval_request_id: Some(updated.id.clone()),
            session_id: None,
            reminder_id: None,
        },
    );

    Ok(updated)
}

/// `input` of `consumeApprovedApprovalRequest` — `service.ts:160-165`.
pub struct ConsumeApprovedApprovalRequestInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub action_type: &'a str,
    pub fingerprint: &'a str,
}

/// `consumeApprovedApprovalRequest` — `service.ts:160-192`.
pub fn consume_approved_approval_request(
    input: &ConsumeApprovedApprovalRequestInput<'_>,
    publisher: &dyn MasterEventPublisher,
) -> Result<Option<MasterApprovalRequest>, ApprovalServiceError> {
    let request = input
        .repo
        .list_approval_requests(input.scope, None, LIST_APPROVAL_REQUESTS_LIMIT)?
        .into_iter()
        .find(|candidate| {
            candidate.status == "approved"
                && candidate.decision.as_deref() == Some(ApprovalDecision::ApproveOnce.as_str())
                && candidate.action_type == input.action_type
                && candidate.fingerprint == input.fingerprint
        });
    let Some(request) = request else {
        return Ok(None);
    };

    let consumed = input.repo.update_approval_request(
        input.scope,
        &request.id,
        &ApprovalPatch {
            status: Some("expired".to_string()),
            decision_reason: Some(Some(
                request
                    .decision_reason
                    .clone()
                    .unwrap_or_else(|| "approve_once consumed by runtime".to_string()),
            )),
            ..ApprovalPatch::default()
        },
    )?;
    if let Some(consumed) = &consumed {
        publish_master_updated(
            publisher,
            &PublishMasterUpdatedInput {
                scope: input.scope.clone(),
                resources: APPROVAL_RESOURCES.to_vec(),
                run_id: Some(consumed.run_id.clone()),
                approval_request_id: Some(consumed.id.clone()),
                session_id: None,
                reminder_id: None,
            },
        );
    }
    Ok(consumed)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::TimeZone;

    use super::*;
    use crate::master::live_events::{MasterUpdatedEvent, NoopMasterEventPublisher};
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    use crate::master::types::MasterRunCreateInput;

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

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
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

    fn pending_input<'a>(
        repo: &'a SqliteMasterRepository,
        scope: &'a WorkspaceScope,
        run_id: &'a str,
    ) -> CreatePendingApprovalRequestInput<'a> {
        CreatePendingApprovalRequestInput {
            repo,
            scope,
            run_id,
            step_id: "step-1",
            action_type: "file.write",
            summary: "Write a file",
            host: Some("gateway"),
            cwd: Some("/tmp"),
            resolved_path: None,
            fingerprint: "file.write:/tmp",
            risk_level: "high",
            tool_name: None,
            prompt: None,
            expires_at: None,
        }
    }

    fn create(
        repo: &SqliteMasterRepository,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> MasterApprovalRequest {
        create_pending_approval_request(
            &pending_input(repo, scope, run_id),
            &NoopMasterEventPublisher,
            now(),
        )
        .unwrap()
    }

    #[test]
    fn create_builds_prompt_ttl_and_audit_event() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scope = scope();
        let run_id = run(&repo);

        let request = create_pending_approval_request(
            &pending_input(&repo, &scope, &run_id),
            &publisher,
            now(),
        )
        .unwrap();

        assert_eq!(
            request.prompt,
            "Approval required for file.write: Write a file"
        );
        assert_eq!(request.status, "pending");
        assert_eq!(request.tool_name, "file.write");
        assert_eq!(request.expires_at, "2026-01-01T00:05:00.000Z");
        assert_eq!(request.host.as_deref(), Some("gateway"));
        let updated_run = repo.get_run(&scope, &run_id).unwrap().unwrap();
        assert_eq!(updated_run.status, "AWAITING_APPROVAL");
        assert!(updated_run.paused_for_approval);
        let audit = repo.list_audit_events(&scope, 10).unwrap();
        assert_eq!(audit[0].action, "request_created");
        assert_eq!(publisher.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn create_returns_the_pending_request_of_the_same_fingerprint() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);

        let first = create(&repo, &scope, &run_id);
        let second = create(&repo, &scope, &run_id);

        assert_eq!(first.id, second.id);
    }

    #[test]
    fn deny_returns_the_run_to_refining() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let request = create(&repo, &scope, &run_id);

        let updated = apply_approval_decision(
            &ApplyApprovalDecisionInput {
                repo: &repo,
                scope: &scope,
                request_id: &request.id,
                decision: ApprovalDecision::Deny,
            },
            &NoopMasterEventPublisher,
            now(),
        )
        .unwrap();

        assert_eq!(updated.status, "denied");
        assert_eq!(updated.decision.as_deref(), Some("deny"));
        assert_eq!(
            updated.decision_reason.as_deref(),
            Some("Action denied by operator.")
        );
        let run = repo.get_run(&scope, &run_id).unwrap().unwrap();
        assert_eq!(run.status, "REFINING");
        assert!(!run.paused_for_approval);
        assert_eq!(run.last_error.as_deref(), Some("Action denied: file.write"));
    }

    #[test]
    fn approve_always_records_a_standing_rule() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let request = create(&repo, &scope, &run_id);

        apply_approval_decision(
            &ApplyApprovalDecisionInput {
                repo: &repo,
                scope: &scope,
                request_id: &request.id,
                decision: ApprovalDecision::ApproveAlways,
            },
            &NoopMasterEventPublisher,
            now(),
        )
        .unwrap();

        assert_eq!(
            repo.get_approval_rule(&scope, "file.write", "file.write:/tmp")
                .unwrap()
                .as_deref(),
            Some("approve_always")
        );
        assert_eq!(
            repo.get_run(&scope, &run_id).unwrap().unwrap().status,
            "EXECUTING"
        );
    }

    #[test]
    fn a_missing_request_is_reported() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let error = apply_approval_decision(
            &ApplyApprovalDecisionInput {
                repo: &repo,
                scope: &scope,
                request_id: "missing",
                decision: ApprovalDecision::ApproveOnce,
            },
            &NoopMasterEventPublisher,
            now(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Approval request not found.");
    }

    #[test]
    fn consume_burns_one_approve_once_request() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let request = create(&repo, &scope, &run_id);
        apply_approval_decision(
            &ApplyApprovalDecisionInput {
                repo: &repo,
                scope: &scope,
                request_id: &request.id,
                decision: ApprovalDecision::ApproveOnce,
            },
            &NoopMasterEventPublisher,
            now(),
        )
        .unwrap();

        let consume = ConsumeApprovedApprovalRequestInput {
            repo: &repo,
            scope: &scope,
            action_type: "file.write",
            fingerprint: "file.write:/tmp",
        };
        let consumed = consume_approved_approval_request(&consume, &NoopMasterEventPublisher)
            .unwrap()
            .expect("consumed");
        assert_eq!(consumed.status, "expired");
        assert_eq!(
            consumed.decision_reason.as_deref(),
            Some("Approved for a single matching action.")
        );
        assert!(
            consume_approved_approval_request(&consume, &NoopMasterEventPublisher)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn the_reason_table_matches_the_source() {
        assert_eq!(
            build_decision_reason(ApprovalDecision::ApproveOnce),
            "Approved for a single matching action."
        );
        assert_eq!(
            build_decision_reason(ApprovalDecision::Deny),
            "Action denied by operator."
        );
    }
}
