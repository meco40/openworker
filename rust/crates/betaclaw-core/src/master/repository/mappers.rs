//! Port of `src/server/master/repository/mappers.ts:1-295`.
//!
//! One `toX(row)` per row shape. The TypeScript reads `SELECT *` rows as
//! `Record<string, unknown>` and coerces with three idioms that this port
//! reproduces explicitly so the two implementations cannot drift:
//!
//! | TypeScript idiom                        | Rust helper |
//! | --------------------------------------- | ----------- |
//! | `String(row.x)`                         | [`text`] (JavaScript `String(value)`) |
//! | `row.x ? String(row.x) : null`          | [`text_or_null`] (empty text → `None`) |
//! | `Number(row.x ?? default)`              | [`int_or`] / [`real_or`] |
//! | `toBool(row.x)`                         | [`bool_col`] (see `helpers::to_bool`) |
//! | `parseJsonArray(row.x)`                 | [`json_array_col`] |
//! | `(row.x as T) ?? null`                  | [`option_text`] (no truthy filter) |
//!
//! `toWorkspaceScope` (`mappers.ts:290-295`) keeps `String()` for both
//! identifiers and is the only mapper that reads a bare `{ user_id,
//! workspace_id }` row.

use rusqlite::types::Value as SqliteValue;
use rusqlite::Row;

use super::super::types::{
    MasterActionLedgerEntry, MasterApprovalRequest, MasterAuditEvent, MasterCapabilityProposal,
    MasterCapabilityScore, MasterConnectorSecret, MasterDelegationEvent, MasterDelegationJob,
    MasterFeedback, MasterNote, MasterReminder, MasterRun, MasterStep, MasterSubagentSession,
    MasterToolForgeArtifact, MasterToolPolicy, WorkspaceScope,
};
use super::helpers::{parse_json_array, to_bool};

/// JavaScript `String(value)` for a SQLite value.
fn js_string(value: &SqliteValue) -> String {
    match value {
        SqliteValue::Null => "null".to_string(),
        SqliteValue::Integer(number) => number.to_string(),
        SqliteValue::Real(number) => js_number(*number),
        SqliteValue::Text(text) => text.clone(),
        SqliteValue::Blob(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// JavaScript numeric stringification. Rust already prints integral floats
/// without a trailing `.0`, which covers the values these columns hold.
fn js_number(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_string();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    number.to_string()
}

/// `String(row.x)`.
fn text(row: &Row<'_>, column: &str) -> rusqlite::Result<String> {
    Ok(js_string(&row.get::<_, SqliteValue>(column)?))
}

/// `row.x ? String(row.x) : null` — the truthy-or-null coercion.
fn text_or_null(row: &Row<'_>, column: &str) -> rusqlite::Result<Option<String>> {
    Ok(match row.get::<_, SqliteValue>(column)? {
        SqliteValue::Null => None,
        SqliteValue::Text(value) if value.is_empty() => None,
        value => Some(js_string(&value)),
    })
}

/// `String(row.x || fallback)` — a falsy value becomes the fallback.
fn text_or(row: &Row<'_>, column: &str, fallback: &str) -> rusqlite::Result<String> {
    Ok(text_or_null(row, column)?.unwrap_or_else(|| fallback.to_string()))
}

/// `Number(row.x ?? default)` for an integer column.
fn int_or(row: &Row<'_>, column: &str, default: i64) -> rusqlite::Result<i64> {
    Ok(match row.get::<_, SqliteValue>(column)? {
        SqliteValue::Null => default,
        SqliteValue::Integer(number) => number,
        SqliteValue::Real(number) => number as i64,
        SqliteValue::Text(value) => value.parse::<i64>().unwrap_or(default),
        SqliteValue::Blob(_) => default,
    })
}

/// `Number(row.x ?? default)` for a real column.
fn real_or(row: &Row<'_>, column: &str, default: f64) -> rusqlite::Result<f64> {
    Ok(match row.get::<_, SqliteValue>(column)? {
        SqliteValue::Null => default,
        SqliteValue::Integer(number) => number as f64,
        SqliteValue::Real(number) => number,
        SqliteValue::Text(value) => value.parse::<f64>().unwrap_or(default),
        SqliteValue::Blob(_) => default,
    })
}

/// `toBool(row.x)`.
fn bool_col(row: &Row<'_>, column: &str) -> rusqlite::Result<bool> {
    Ok(to_bool(&row.get::<_, SqliteValue>(column)?))
}

/// `parseJsonArray(row.x)`.
fn json_array_col(row: &Row<'_>, column: &str) -> rusqlite::Result<Vec<String>> {
    let raw = match row.get::<_, SqliteValue>(column)? {
        SqliteValue::Text(value) => Some(value),
        _ => None,
    };
    Ok(parse_json_array(raw.as_deref()))
}

/// `(row.x as T) ?? null` — no truthy filter, the empty string survives.
fn option_text(row: &Row<'_>, column: &str) -> rusqlite::Result<Option<String>> {
    Ok(match row.get::<_, SqliteValue>(column)? {
        SqliteValue::Null => None,
        value => Some(js_string(&value)),
    })
}

/// `toRun` from `mappers.ts:22-46`.
pub fn to_run(row: &Row<'_>) -> rusqlite::Result<MasterRun> {
    Ok(MasterRun {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        title: text(row, "title")?,
        contract: text(row, "contract")?,
        status: text(row, "status")?,
        progress: int_or(row, "progress", 0)?,
        verification_passed: bool_col(row, "verification_passed")?,
        result_bundle: text_or_null(row, "result_bundle")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
        last_error: text_or_null(row, "last_error")?,
        paused_for_approval: bool_col(row, "paused_for_approval")?,
        pending_approval_action_type: text_or_null(row, "pending_approval_action_type")?,
        cancelled_at: text_or_null(row, "cancelled_at")?,
        cancel_reason: text_or_null(row, "cancel_reason")?,
        owner_id: text_or_null(row, "owner_id")?,
        lease_expires_at: text_or_null(row, "lease_expires_at")?,
        heartbeat_at: text_or_null(row, "heartbeat_at")?,
    })
}

/// `toStep` from `mappers.ts:48-62`.
pub fn to_step(row: &Row<'_>) -> rusqlite::Result<MasterStep> {
    Ok(MasterStep {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        seq: int_or(row, "seq", 0)?,
        phase: text(row, "phase")?,
        status: text(row, "status")?,
        input: text_or_null(row, "input")?,
        output: text_or_null(row, "output")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toFeedback` from `mappers.ts:64-75`.
pub fn to_feedback(row: &Row<'_>) -> rusqlite::Result<MasterFeedback> {
    Ok(MasterFeedback {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        rating: int_or(row, "rating", 0)?,
        policy: text(row, "policy")?,
        comment: text_or_null(row, "comment")?,
        created_at: text(row, "created_at")?,
    })
}

/// `toNote` from `mappers.ts:77-88`.
pub fn to_note(row: &Row<'_>) -> rusqlite::Result<MasterNote> {
    Ok(MasterNote {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        title: text(row, "title")?,
        content: text(row, "content")?,
        tags: json_array_col(row, "tags")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toReminder` from `mappers.ts:90-103`.
pub fn to_reminder(row: &Row<'_>) -> rusqlite::Result<MasterReminder> {
    Ok(MasterReminder {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        title: text(row, "title")?,
        message: text(row, "message")?,
        remind_at: text(row, "remind_at")?,
        cron_expression: text_or_null(row, "cron_expression")?,
        status: text(row, "status")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toDelegationJob` from `mappers.ts:105-122`.
pub fn to_delegation_job(row: &Row<'_>) -> rusqlite::Result<MasterDelegationJob> {
    Ok(MasterDelegationJob {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        capability: text(row, "capability")?,
        payload: text(row, "payload")?,
        status: text(row, "status")?,
        priority: text(row, "priority")?,
        attempts: int_or(row, "attempts", 0)?,
        max_attempts: int_or(row, "max_attempts", 3)?,
        timeout_ms: int_or(row, "timeout_ms", 120_000)?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
        last_error: text_or_null(row, "last_error")?,
    })
}

/// `toDelegationEvent` from `mappers.ts:124-135`.
pub fn to_delegation_event(row: &Row<'_>) -> rusqlite::Result<MasterDelegationEvent> {
    Ok(MasterDelegationEvent {
        id: text(row, "id")?,
        job_id: text(row, "job_id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        event_type: text(row, "type")?,
        payload: text(row, "payload")?,
        created_at: text(row, "created_at")?,
    })
}

/// `toActionLedgerEntry` from `mappers.ts:137-151`.
pub fn to_action_ledger_entry(row: &Row<'_>) -> rusqlite::Result<MasterActionLedgerEntry> {
    Ok(MasterActionLedgerEntry {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        step_id: text(row, "step_id")?,
        action_type: text(row, "action_type")?,
        idempotency_key: text(row, "idempotency_key")?,
        state: text(row, "state")?,
        result_payload: text_or_null(row, "result_payload")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toApprovalRequest` from `mappers.ts:153-180`.
pub fn to_approval_request(row: &Row<'_>) -> rusqlite::Result<MasterApprovalRequest> {
    let host = match option_text(row, "host")?.as_deref() {
        Some("gateway") => Some("gateway".to_string()),
        Some("sandbox") => Some("sandbox".to_string()),
        _ => None,
    };
    Ok(MasterApprovalRequest {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        step_id: text(row, "step_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        tool_name: text(row, "tool_name")?,
        action_type: text(row, "action_type")?,
        summary: text(row, "summary")?,
        prompt: text(row, "prompt")?,
        host,
        cwd: text_or_null(row, "cwd")?,
        resolved_path: text_or_null(row, "resolved_path")?,
        fingerprint: text(row, "fingerprint")?,
        risk_level: text(row, "risk_level")?,
        status: text(row, "status")?,
        expires_at: text(row, "expires_at")?,
        decision: option_text(row, "decision")?,
        decision_reason: text_or_null(row, "decision_reason")?,
        decided_at: text_or_null(row, "decided_at")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toToolPolicy` from `mappers.ts:182-194`.
pub fn to_tool_policy(row: &Row<'_>) -> rusqlite::Result<MasterToolPolicy> {
    Ok(MasterToolPolicy {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        security: text(row, "security")?,
        ask: text(row, "ask")?,
        allowlist: json_array_col(row, "allowlist")?,
        updated_by: text_or_null(row, "updated_by")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toSubagentSession` from `mappers.ts:196-215`.
pub fn to_subagent_session(row: &Row<'_>) -> rusqlite::Result<MasterSubagentSession> {
    Ok(MasterSubagentSession {
        id: text(row, "id")?,
        run_id: text(row, "run_id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        status: text(row, "status")?,
        title: text(row, "title")?,
        prompt: text(row, "prompt")?,
        assigned_tools: json_array_col(row, "assigned_tools")?,
        owner_id: text_or_null(row, "owner_id")?,
        lease_expires_at: text_or_null(row, "lease_expires_at")?,
        heartbeat_at: text_or_null(row, "heartbeat_at")?,
        latest_event_at: text_or_null(row, "latest_event_at")?,
        result_summary: text_or_null(row, "result_summary")?,
        last_error: text_or_null(row, "last_error")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toCapabilityScore` from `mappers.ts:217-228`.
pub fn to_capability_score(row: &Row<'_>) -> rusqlite::Result<MasterCapabilityScore> {
    Ok(MasterCapabilityScore {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        capability: text(row, "capability")?,
        confidence: real_or(row, "confidence", 0.0)?,
        last_verified_at: text_or_null(row, "last_verified_at")?,
        benchmark_summary: text_or(row, "benchmark_summary", "{}")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toCapabilityProposal` from `mappers.ts:230-243`.
pub fn to_capability_proposal(row: &Row<'_>) -> rusqlite::Result<MasterCapabilityProposal> {
    Ok(MasterCapabilityProposal {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        title: text(row, "title")?,
        capability_key: text(row, "capability_key")?,
        status: text(row, "status")?,
        proposal: text(row, "proposal")?,
        fallback_plan: text(row, "fallback_plan")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toToolForgeArtifact` from `mappers.ts:245-260`.
pub fn to_toolforge_artifact(row: &Row<'_>) -> rusqlite::Result<MasterToolForgeArtifact> {
    Ok(MasterToolForgeArtifact {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        name: text(row, "name")?,
        spec: text(row, "spec")?,
        manifest: text(row, "manifest")?,
        test_summary: text(row, "test_summary")?,
        risk_report: text(row, "risk_report")?,
        status: text(row, "status")?,
        published_globally: bool_col(row, "published_globally")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toConnectorSecret` from `mappers.ts:262-276`.
pub fn to_connector_secret(row: &Row<'_>) -> rusqlite::Result<MasterConnectorSecret> {
    Ok(MasterConnectorSecret {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        provider: text(row, "provider")?,
        key_ref: text(row, "key_ref")?,
        encrypted_payload: text(row, "encrypted_payload")?,
        issued_at: text_or_null(row, "issued_at")?,
        expires_at: text_or_null(row, "expires_at")?,
        revoked_at: text_or_null(row, "revoked_at")?,
        created_at: text(row, "created_at")?,
        updated_at: text(row, "updated_at")?,
    })
}

/// `toAuditEvent` from `mappers.ts:278-288`.
pub fn to_audit_event(row: &Row<'_>) -> rusqlite::Result<MasterAuditEvent> {
    Ok(MasterAuditEvent {
        id: text(row, "id")?,
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
        category: text(row, "category")?,
        action: text(row, "action")?,
        metadata: text_or(row, "metadata", "{}")?,
        created_at: text(row, "created_at")?,
    })
}

/// `toWorkspaceScope` from `mappers.ts:290-295`.
pub fn to_workspace_scope(row: &Row<'_>) -> rusqlite::Result<WorkspaceScope> {
    Ok(WorkspaceScope {
        user_id: text(row, "user_id")?,
        workspace_id: text(row, "workspace_id")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn connection() -> rusqlite::Connection {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        connection
    }

    #[test]
    fn run_mapper_matches_the_source_coercions() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO master_runs (id, user_id, workspace_id, title, contract, status, progress,
                    verification_passed, result_bundle, last_error, paused_for_approval,
                    pending_approval_action_type, cancelled_at, cancel_reason, owner_id,
                    lease_expires_at, heartbeat_at, created_at, updated_at)
                 VALUES ('r1', 'u1', 'w1', 'T', 'C', 'ANALYZING', 3, 1, NULL, '', 0, NULL, NULL, NULL,
                    NULL, NULL, NULL, 't0', 't1')",
                [],
            )
            .unwrap();
        let run: MasterRun = connection
            .query_row("SELECT * FROM master_runs WHERE id = 'r1'", [], |row| {
                to_run(row)
            })
            .unwrap();
        assert_eq!(run.status, "ANALYZING");
        assert_eq!(run.progress, 3);
        assert!(run.verification_passed);
        assert!(run.result_bundle.is_none());
        // `row.last_error ? ... : null` treats the empty string as falsy.
        assert!(run.last_error.is_none());
        assert!(!run.paused_for_approval);
    }

    #[test]
    fn note_tags_parse_from_json_text() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO master_notes (id, user_id, workspace_id, title, content, tags, created_at, updated_at)
                 VALUES ('n1', 'u1', 'w1', 'T', 'B', '[\"a\",\"b\"]', 't0', 't1')",
                [],
            )
            .unwrap();
        let note = connection
            .query_row("SELECT * FROM master_notes WHERE id = 'n1'", [], |row| {
                to_note(row)
            })
            .unwrap();
        assert_eq!(note.tags, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn approval_host_is_whitelisted() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO master_approval_requests (id, run_id, step_id, user_id, workspace_id, tool_name,
                    action_type, summary, prompt, host, cwd, resolved_path, fingerprint, risk_level, status,
                    expires_at, decision, decision_reason, decided_at, created_at, updated_at)
                 VALUES ('a1', 'r1', 's1', 'u1', 'w1', 'shell', 'exec', 'sum', 'prompt', 'somewhere', NULL, NULL,
                    'fp', 'low', 'pending', 't2', '', NULL, NULL, 't0', 't1')",
                [],
            )
            .unwrap();
        let request = connection
            .query_row(
                "SELECT * FROM master_approval_requests WHERE id = 'a1'",
                [],
                to_approval_request,
            )
            .unwrap();
        // An unknown host collapses to null; an empty decision survives.
        assert!(request.host.is_none());
        assert_eq!(request.decision.as_deref(), Some(""));
    }

    #[test]
    fn delegation_job_defaults_follow_the_source() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO master_subagent_jobs (id, run_id, user_id, workspace_id, capability, payload,
                    status, priority, created_at, updated_at)
                 VALUES ('j1', 'r1', 'u1', 'w1', 'cap', 'p', 'queued', 'high', 't0', 't1')",
                [],
            )
            .unwrap();
        let job = connection
            .query_row(
                "SELECT * FROM master_subagent_jobs WHERE id = 'j1'",
                [],
                to_delegation_job,
            )
            .unwrap();
        assert_eq!(job.max_attempts, 3);
        assert_eq!(job.timeout_ms, 120_000);
        assert_eq!(job.attempts, 0);
    }

    #[test]
    fn workspace_scope_mapper_reads_both_columns() {
        let connection = connection();
        connection
            .execute(
                "INSERT INTO master_notes (id, user_id, workspace_id, title, content, tags, created_at, updated_at)
                 VALUES ('n1', 'u9', 'w9', 'T', 'B', '[]', 't0', 't1')",
                [],
            )
            .unwrap();
        let scope = connection
            .query_row(
                "SELECT user_id, workspace_id FROM master_notes WHERE id = 'n1'",
                [],
                to_workspace_scope,
            )
            .unwrap();
        assert_eq!(
            scope,
            WorkspaceScope {
                user_id: "u9".to_string(),
                workspace_id: "w9".to_string()
            }
        );
    }
}
