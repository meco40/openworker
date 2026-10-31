//! Port of `src/server/master/delegation/sessionService.ts:1-304`.
//!
//! The lifecycle of one subagent session, plus the two pairing helpers that line
//! a session up with its delegation job (`pairJobForSession`,
//! `findSessionForJob`). Sessions and jobs are read back through the
//! [`MasterRepository`]; the ordering key is `createdAt` ascending with the id as
//! tie-break, exactly like the source.
//!
//! # Dates: parse, not re-derive
//!
//! `nowIso`, `expiresAt` and `isLeaseExpired` all go through
//! `new Date(...).getTime()` (`sessionService.ts:16-22,63-66`). The port parses
//! RFC 3339 and formats back with [`chrono`], so an ISO string that the source
//! round-tripped is preserved by the port too. An unparseable *present*
//! `leaseExpiresAt` is treated as not expired, and an empty string counts as
//! absent (`!session.leaseExpiresAt` is true for `''`), matching JavaScript
//! falsiness.
//!
//! # `localeCompare` on UUID ids
//!
//! `id.localeCompare` (`:42,57,286`) is a locale collation; every id in this
//! package is an ASCII UUID, for which the ICU root collation reduces to byte
//! order — which is what Rust's `Ord` on `String` gives. The deviation only
//! matters if a non-ASCII id were ever stored.
//!
//! # UTF-16 vs Unicode-scalar length
//!
//! `summarizePayload` (`:24-28`) slices by JavaScript string index (UTF-16 code
//! units). The port counts Unicode scalar values; a payload whose first 180
//! UTF-16 units straddle a surrogate pair is the only input where the two cut
//! differently.

use std::cmp::Ordering;

use chrono::{DateTime, SecondsFormat, Utc};

use crate::master::live_events::{
    publish_master_updated, MasterEventPublisher, MasterInvalidationResource,
    PublishMasterUpdatedInput,
};
use crate::master::repository::delegation_store::{DelegationPatch, MasterDelegationEventInput};
use crate::master::repository::helpers::now_iso;
use crate::master::repository::sessions_store::{MasterSubagentSessionInput, SubagentSessionPatch};
use crate::master::repository::MasterRepository;
use crate::master::types::{
    MasterDelegationEvent, MasterDelegationJob, MasterSubagentSession, WorkspaceScope,
};

use super::session_types::{ClaimSubagentSessionInput, SubagentSessionDetail};

/// `DEFAULT_LEASE_MS` — `sessionService.ts:14` (`30_000`).
pub const DEFAULT_LEASE_MS: i64 = 30_000;

/// `listSubagentSessions(..., 500)` — `sessionService.ts:52,142,282`.
pub const SESSION_SCAN_LIMIT: i64 = 500;

/// `nowIso` from `sessionService.ts:16-18`.
fn now_iso_default() -> String {
    now_iso()
}

/// `new Date(value).getTime()` — `sessionService.ts:21,40,55,65`.
fn parse_iso_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

/// `new Date(ms).toISOString()`.
fn iso_from_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// `expiresAt` from `sessionService.ts:20-22`.
fn expires_at(now: &str, lease_ms: i64) -> String {
    match parse_iso_ms(now) {
        Some(ms) => iso_from_ms(ms + lease_ms),
        // `new Date(invalid)` is `NaN`, so the source would throw on
        // `toISOString`; the port keeps the input instead of panicking.
        None => now.to_string(),
    }
}

/// `summarizePayload` from `sessionService.ts:24-28`.
fn summarize_payload(payload: &str) -> String {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return "Review delegated task context.".to_string();
    }
    let characters: Vec<char> = trimmed.chars().collect();
    if characters.len() > 180 {
        let head: String = characters[..177].iter().collect();
        format!("{head}...")
    } else {
        trimmed.to_string()
    }
}

/// `buildSessionTitle` from `sessionService.ts:30-36`.
fn build_session_title(capability: &str) -> String {
    capability
        .split(['_', '-', '.'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn compare_created_then_id(left: &str, right: &str, left_id: &str, right_id: &str) -> Ordering {
    let left_ms = parse_iso_ms(left).unwrap_or(0);
    let right_ms = parse_iso_ms(right).unwrap_or(0);
    match left_ms.cmp(&right_ms) {
        Ordering::Equal => left_id.cmp(right_id),
        other => other,
    }
}

/// `sortSessionsForPairing` from `sessionService.ts:38-44`.
fn sort_sessions_for_pairing(
    mut sessions: Vec<MasterSubagentSession>,
) -> Vec<MasterSubagentSession> {
    sessions.sort_by(|left, right| {
        compare_created_then_id(&left.created_at, &right.created_at, &left.id, &right.id)
    });
    sessions
}

/// The same comparator applied to jobs — `sessionService.ts:54-58,283-287`.
fn sort_jobs_for_pairing(mut jobs: Vec<MasterDelegationJob>) -> Vec<MasterDelegationJob> {
    jobs.sort_by(|left, right| {
        compare_created_then_id(&left.created_at, &right.created_at, &left.id, &right.id)
    });
    jobs
}

/// `pairJobForSession` from `sessionService.ts:46-61`.
fn pair_job_for_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session: &MasterSubagentSession,
) -> rusqlite::Result<Option<MasterDelegationJob>> {
    let ordered_sessions = sort_sessions_for_pairing(repo.list_subagent_sessions(
        scope,
        Some(&session.run_id),
        SESSION_SCAN_LIMIT,
    )?);
    let ordered_jobs = sort_jobs_for_pairing(repo.list_delegation_jobs(scope, &session.run_id)?);
    let index = ordered_sessions
        .iter()
        .position(|entry| entry.id == session.id);
    Ok(index.and_then(|index| ordered_jobs.get(index).cloned()))
}

/// `isLeaseExpired` from `sessionService.ts:63-66`.
fn is_lease_expired(session: &MasterSubagentSession, now: &str) -> bool {
    match session.lease_expires_at.as_deref() {
        None | Some("") => true,
        Some(lease) => match parse_iso_ms(lease) {
            Some(lease_ms) => lease_ms <= parse_iso_ms(now).unwrap_or(0),
            None => false,
        },
    }
}

const SUBAGENT_RESOURCES: &[MasterInvalidationResource] = &[
    MasterInvalidationResource::Subagents,
    MasterInvalidationResource::Metrics,
];

fn publish_subagents(
    publisher: &dyn MasterEventPublisher,
    scope: &WorkspaceScope,
    session: &MasterSubagentSession,
) {
    publish_master_updated(
        publisher,
        &PublishMasterUpdatedInput {
            scope: scope.clone(),
            resources: SUBAGENT_RESOURCES.to_vec(),
            run_id: Some(session.run_id.clone()),
            approval_request_id: None,
            session_id: Some(session.id.clone()),
            reminder_id: None,
        },
    );
}

/// `input` of `createSubagentSessionForDispatch` — `sessionService.ts:71-76`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateSubagentSessionForDispatchInput {
    pub run_id: String,
    pub capability: String,
    pub payload: String,
    /// `assignedTools?` — absent becomes `[capability]`.
    pub assigned_tools: Option<Vec<String>>,
}

/// `createSubagentSessionForDispatch` — `sessionService.ts:68-98`.
pub fn create_subagent_session_for_dispatch(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    input: &CreateSubagentSessionForDispatchInput,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<MasterSubagentSession> {
    let created = repo.create_subagent_session(
        scope,
        &MasterSubagentSessionInput {
            run_id: input.run_id.clone(),
            status: "queued".to_string(),
            title: build_session_title(&input.capability),
            prompt: summarize_payload(&input.payload),
            assigned_tools: input
                .assigned_tools
                .clone()
                .unwrap_or_else(|| vec![input.capability.clone()]),
            owner_id: None,
            lease_expires_at: None,
            heartbeat_at: None,
            latest_event_at: None,
            result_summary: None,
            last_error: None,
        },
    )?;
    publish_subagents(publisher, scope, &created);
    Ok(created)
}

/// `Omit<ClaimSubagentSessionInput, 'runId'>` — `sessionService.ts:104`.
pub struct ClaimSubagentSessionRequest<'a> {
    pub owner_id: &'a str,
    pub now: Option<&'a str>,
    pub lease_ms: Option<i64>,
}

/// `claimSubagentSession` — `sessionService.ts:100-134`.
pub fn claim_subagent_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
    input: &ClaimSubagentSessionRequest<'_>,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let Some(session) = repo.get_subagent_session(scope, session_id)? else {
        return Ok(None);
    };
    let now = input
        .now
        .map(str::to_string)
        .unwrap_or_else(now_iso_default);
    if session.status == "cancelled" || session.status == "completed" {
        return Ok(None);
    }
    if session.status == "running"
        && !is_lease_expired(&session, &now)
        && session.owner_id.as_deref() != Some(input.owner_id)
    {
        return Ok(None);
    }
    let updated = repo.update_subagent_session(
        scope,
        session_id,
        &SubagentSessionPatch {
            status: Some("running".to_string()),
            owner_id: Some(Some(input.owner_id.to_string())),
            lease_expires_at: Some(Some(expires_at(
                &now,
                input.lease_ms.unwrap_or(DEFAULT_LEASE_MS),
            ))),
            heartbeat_at: Some(Some(now)),
            ..SubagentSessionPatch::default()
        },
    )?;
    if let Some(updated) = &updated {
        publish_subagents(publisher, scope, updated);
    }
    Ok(updated)
}

/// `claimNextSubagentSession` — `sessionService.ts:136-154`.
pub fn claim_next_subagent_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    input: &ClaimSubagentSessionInput,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let now = input.now.clone().unwrap_or_else(now_iso_default);
    let sessions =
        repo.list_subagent_sessions(scope, input.run_id.as_deref(), SESSION_SCAN_LIMIT)?;
    let queued = sort_sessions_for_pairing(
        sessions
            .iter()
            .filter(|session| session.status == "queued")
            .cloned()
            .collect(),
    );
    let reclaimable = sort_sessions_for_pairing(
        sessions
            .iter()
            .filter(|session| session.status == "running" && is_lease_expired(session, &now))
            .cloned()
            .collect(),
    );
    let Some(candidate) = queued.first().or_else(|| reclaimable.first()) else {
        return Ok(None);
    };
    let candidate_id = candidate.id.clone();
    claim_subagent_session(
        repo,
        scope,
        &candidate_id,
        &ClaimSubagentSessionRequest {
            owner_id: &input.owner_id,
            now: Some(&now),
            lease_ms: input.lease_ms,
        },
        publisher,
    )
}

/// `input` of `syncSubagentSessionHeartbeat` — `sessionService.ts:160`.
pub struct SyncSubagentSessionHeartbeatInput<'a> {
    pub owner_id: &'a str,
    pub now: Option<&'a str>,
    pub lease_ms: Option<i64>,
}

/// `syncSubagentSessionHeartbeat` — `sessionService.ts:156-169`.
pub fn sync_subagent_session_heartbeat(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
    input: &SyncSubagentSessionHeartbeatInput<'_>,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let Some(session) = repo.get_subagent_session(scope, session_id)? else {
        return Ok(None);
    };
    if session.owner_id.as_deref() != Some(input.owner_id) {
        return Ok(None);
    }
    let now = input
        .now
        .map(str::to_string)
        .unwrap_or_else(now_iso_default);
    repo.update_subagent_session(
        scope,
        session_id,
        &SubagentSessionPatch {
            heartbeat_at: Some(Some(now.clone())),
            lease_expires_at: Some(Some(expires_at(
                &now,
                input.lease_ms.unwrap_or(DEFAULT_LEASE_MS),
            ))),
            ..SubagentSessionPatch::default()
        },
    )
}

/// `completeSubagentSession` — `sessionService.ts:171-196`.
pub fn complete_subagent_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
    result_summary: &str,
    latest_event_at: Option<&str>,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let updated = repo.update_subagent_session(
        scope,
        session_id,
        &SubagentSessionPatch {
            status: Some("completed".to_string()),
            owner_id: Some(None),
            lease_expires_at: Some(None),
            heartbeat_at: Some(None),
            latest_event_at: Some(Some(
                latest_event_at
                    .map(str::to_string)
                    .unwrap_or_else(now_iso_default),
            )),
            result_summary: Some(Some(result_summary.to_string())),
            last_error: Some(None),
            ..SubagentSessionPatch::default()
        },
    )?;
    if let Some(updated) = &updated {
        publish_subagents(publisher, scope, updated);
    }
    Ok(updated)
}

/// `failSubagentSession` — `sessionService.ts:198-222`.
pub fn fail_subagent_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
    message: &str,
    latest_event_at: Option<&str>,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let updated = repo.update_subagent_session(
        scope,
        session_id,
        &SubagentSessionPatch {
            status: Some("failed".to_string()),
            owner_id: Some(None),
            lease_expires_at: Some(None),
            heartbeat_at: Some(None),
            latest_event_at: Some(Some(
                latest_event_at
                    .map(str::to_string)
                    .unwrap_or_else(now_iso_default),
            )),
            last_error: Some(Some(message.to_string())),
            ..SubagentSessionPatch::default()
        },
    )?;
    if let Some(updated) = &updated {
        publish_subagents(publisher, scope, updated);
    }
    Ok(updated)
}

/// `cancelSubagentSession` — `sessionService.ts:224-261`.
///
/// `reason = 'cancelled'` is the source default (`:228`); the port takes it as an
/// optional argument. The job is only cancelled while it is still open
/// (`completed`/`failed`/`cancelled` are terminal).
pub fn cancel_subagent_session(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
    reason: Option<&str>,
    publisher: &dyn MasterEventPublisher,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let Some(session) = repo.get_subagent_session(scope, session_id)? else {
        return Ok(None);
    };
    let reason = reason.unwrap_or("cancelled").to_string();
    let job = pair_job_for_session(repo, scope, &session)?;
    let cancelled = repo.update_subagent_session(
        scope,
        session_id,
        &SubagentSessionPatch {
            status: Some("cancelled".to_string()),
            owner_id: Some(None),
            lease_expires_at: Some(None),
            heartbeat_at: Some(None),
            last_error: Some(Some(reason.clone())),
            ..SubagentSessionPatch::default()
        },
    )?;
    if let Some(job) = &job {
        if job.status != "completed" && job.status != "failed" && job.status != "cancelled" {
            repo.update_delegation_job(
                scope,
                &job.id,
                &DelegationPatch {
                    status: Some("cancelled".to_string()),
                    last_error: Some(Some(reason.clone())),
                    ..DelegationPatch::default()
                },
            )?;
            publish_delegation_event(
                repo,
                scope,
                &MasterDelegationEventInput {
                    run_id: session.run_id.clone(),
                    job_id: job.id.clone(),
                    event_type: "cancelled".to_string(),
                    payload: serde_json::json!({ "reason": reason }).to_string(),
                },
            )?;
        }
    }
    if let Some(cancelled) = &cancelled {
        publish_subagents(publisher, scope, cancelled);
    }
    Ok(cancelled)
}

/// `publishDelegationEvent` — `sessionService.ts:263-274`.
pub fn publish_delegation_event(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    event: &MasterDelegationEventInput,
) -> rusqlite::Result<MasterDelegationEvent> {
    let created = repo.append_delegation_event(scope, event)?;
    if let Some(session) = find_session_for_job(repo, scope, &event.run_id, &event.job_id)? {
        repo.update_subagent_session(
            scope,
            &session.id,
            &SubagentSessionPatch {
                latest_event_at: Some(Some(created.created_at.clone())),
                ..SubagentSessionPatch::default()
            },
        )?;
    }
    Ok(created)
}

/// `findSessionForJob` from `sessionService.ts:276-290`.
fn find_session_for_job(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    run_id: &str,
    job_id: &str,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let ordered_sessions = sort_sessions_for_pairing(repo.list_subagent_sessions(
        scope,
        Some(run_id),
        SESSION_SCAN_LIMIT,
    )?);
    let ordered_jobs = sort_jobs_for_pairing(repo.list_delegation_jobs(scope, run_id)?);
    let job_index = ordered_jobs.iter().position(|entry| entry.id == job_id);
    Ok(job_index.and_then(|index| ordered_sessions.get(index).cloned()))
}

/// `getSubagentSessionDetail` — `sessionService.ts:292-304`.
pub fn get_subagent_session_detail(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    session_id: &str,
) -> rusqlite::Result<Option<SubagentSessionDetail>> {
    let Some(session) = repo.get_subagent_session(scope, session_id)? else {
        return Ok(None);
    };
    let job = pair_job_for_session(repo, scope, &session)?;
    let events = match &job {
        Some(job) => repo
            .list_delegation_events(scope, &session.run_id)?
            .into_iter()
            .filter(|event| event.job_id == job.id)
            .collect(),
        None => Vec::new(),
    };
    Ok(Some(SubagentSessionDetail {
        session,
        job,
        events,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::master::live_events::{MasterUpdatedEvent, NoopMasterEventPublisher};
    use crate::master::repository::delegation_store::MasterDelegationJobInput;
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

    fn create_session(
        repo: &SqliteMasterRepository,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> MasterSubagentSession {
        create_subagent_session_for_dispatch(
            repo,
            scope,
            &CreateSubagentSessionForDispatchInput {
                run_id: run_id.to_string(),
                capability: "web_search".to_string(),
                payload: "Find the latest docs".to_string(),
                assigned_tools: None,
            },
            &NoopMasterEventPublisher,
        )
        .unwrap()
    }

    fn create_job(
        repo: &SqliteMasterRepository,
        scope: &WorkspaceScope,
        run_id: &str,
    ) -> MasterDelegationJob {
        repo.create_delegation_job(
            scope,
            &MasterDelegationJobInput {
                run_id: run_id.to_string(),
                capability: "web_search".to_string(),
                payload: "{}".to_string(),
                status: "queued".to_string(),
                priority: "medium".to_string(),
                max_attempts: 3,
                timeout_ms: 120_000,
            },
        )
        .unwrap()
    }

    #[test]
    fn title_and_summary_follow_the_source_rules() {
        assert_eq!(build_session_title("web_search"), "Web Search");
        assert_eq!(build_session_title("system-ops.run"), "System Ops Run");
        assert_eq!(build_session_title(""), "");
        assert_eq!(summarize_payload("   "), "Review delegated task context.");
        let long = "a".repeat(200);
        let summary = summarize_payload(&long);
        assert_eq!(summary.len(), 180);
        assert!(summary.ends_with("..."));
    }

    #[test]
    fn create_then_claim_then_complete_round_trips() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let publisher = RecordingPublisher::default();
        let scope = scope();
        let run_id = run(&repo);
        let session = create_subagent_session_for_dispatch(
            &repo,
            &scope,
            &CreateSubagentSessionForDispatchInput {
                run_id: run_id.clone(),
                capability: "web_search".to_string(),
                payload: "Find the latest docs".to_string(),
                assigned_tools: None,
            },
            &publisher,
        )
        .unwrap();
        assert_eq!(session.status, "queued");
        assert_eq!(session.title, "Web Search");
        assert_eq!(session.assigned_tools, vec!["web_search".to_string()]);

        let claimed = claim_subagent_session(
            &repo,
            &scope,
            &session.id,
            &ClaimSubagentSessionRequest {
                owner_id: "owner-1",
                now: Some("2026-01-01T00:00:00.000Z"),
                lease_ms: Some(30_000),
            },
            &publisher,
        )
        .unwrap()
        .expect("claimed");
        assert_eq!(claimed.status, "running");
        assert_eq!(claimed.owner_id.as_deref(), Some("owner-1"));
        assert_eq!(
            claimed.lease_expires_at.as_deref(),
            Some("2026-01-01T00:00:30.000Z")
        );

        let completed =
            complete_subagent_session(&repo, &scope, &session.id, "done", None, &publisher)
                .unwrap()
                .expect("completed");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.result_summary.as_deref(), Some("done"));
        assert!(completed.owner_id.is_none());
        assert!(publisher.events.lock().unwrap().len() >= 3);
    }

    #[test]
    fn a_live_lease_held_by_another_owner_blocks_the_claim() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let session = create_session(&repo, &scope, &run_id);
        claim_subagent_session(
            &repo,
            &scope,
            &session.id,
            &ClaimSubagentSessionRequest {
                owner_id: "owner-1",
                now: Some("2026-01-01T00:00:00.000Z"),
                lease_ms: Some(30_000),
            },
            &NoopMasterEventPublisher,
        )
        .unwrap();

        let blocked = claim_subagent_session(
            &repo,
            &scope,
            &session.id,
            &ClaimSubagentSessionRequest {
                owner_id: "owner-2",
                now: Some("2026-01-01T00:00:10.000Z"),
                lease_ms: Some(30_000),
            },
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert!(blocked.is_none());

        // Once the lease lapsed, another owner may reclaim it.
        let reclaimed = claim_subagent_session(
            &repo,
            &scope,
            &session.id,
            &ClaimSubagentSessionRequest {
                owner_id: "owner-2",
                now: Some("2026-01-01T00:01:00.000Z"),
                lease_ms: Some(30_000),
            },
            &NoopMasterEventPublisher,
        )
        .unwrap()
        .expect("reclaimed");
        assert_eq!(reclaimed.owner_id.as_deref(), Some("owner-2"));
    }

    #[test]
    fn cancel_closes_the_session_and_its_open_job() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let session = create_session(&repo, &scope, &run_id);
        let job = create_job(&repo, &scope, &run_id);

        let cancelled =
            cancel_subagent_session(&repo, &scope, &session.id, None, &NoopMasterEventPublisher)
                .unwrap()
                .expect("cancelled");
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.last_error.as_deref(), Some("cancelled"));
        let job_after = repo.list_delegation_jobs(&scope, &run_id).unwrap();
        assert_eq!(job_after[0].id, job.id);
        assert_eq!(job_after[0].status, "cancelled");
    }

    #[test]
    fn heartbeat_only_moves_for_the_owner() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let run_id = run(&repo);
        let session = create_session(&repo, &scope, &run_id);
        claim_subagent_session(
            &repo,
            &scope,
            &session.id,
            &ClaimSubagentSessionRequest {
                owner_id: "owner-1",
                now: Some("2026-01-01T00:00:00.000Z"),
                lease_ms: Some(30_000),
            },
            &NoopMasterEventPublisher,
        )
        .unwrap();

        assert!(sync_subagent_session_heartbeat(
            &repo,
            &scope,
            &session.id,
            &SyncSubagentSessionHeartbeatInput {
                owner_id: "owner-2",
                now: Some("2026-01-01T00:00:05.000Z"),
                lease_ms: None,
            },
        )
        .unwrap()
        .is_none());

        let synced = sync_subagent_session_heartbeat(
            &repo,
            &scope,
            &session.id,
            &SyncSubagentSessionHeartbeatInput {
                owner_id: "owner-1",
                now: Some("2026-01-01T00:00:05.000Z"),
                lease_ms: Some(10_000),
            },
        )
        .unwrap()
        .expect("synced");
        assert_eq!(
            synced.heartbeat_at.as_deref(),
            Some("2026-01-01T00:00:05.000Z")
        );
        assert_eq!(
            synced.lease_expires_at.as_deref(),
            Some("2026-01-01T00:00:15.000Z")
        );
    }
}
