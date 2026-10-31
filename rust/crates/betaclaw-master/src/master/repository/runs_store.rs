//! Port of `src/server/master/repository/runs.store.ts:1-242`.
//!
//! Runs, steps and feedback over `master_runs`, `master_steps` and
//! `master_feedback`, scoped by `(user_id, workspace_id)`.
//!
//! # Lease SQL
//!
//! `claimRun` is the lease acquisition: one `UPDATE` guarded by
//! `owner_id IS NULL OR owner_id = ? OR lease_expires_at IS NULL OR
//! lease_expires_at <= ?`. `renewRunLease` and `releaseRunLease` add `owner_id = ?`
//! to the predicate and return `None` when `changes === 0`. The statements are
//! reproduced verbatim.
//!
//! # Boolean columns
//!
//! `updateRun` writes `verificationPassed` / `pausedForApproval` as `1`/`0`
//! (`runs.store.ts:80-84`); every other column uses `value ?? null`.
//!
//! `appendStep` and `addFeedback` insert then read back; the TypeScript
//! arguments `step.runId` / `step.userId` / `step.workspaceId` and
//! `feedback.userId` / `feedback.workspaceId` are ignored by the source in
//! favour of the explicit `runId`/`scope`, so the port's inputs only carry the
//! columns the source actually reads.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::{to_feedback, to_run, to_step};
use crate::master::repository::required;
use crate::master::types::{
    MasterFeedback, MasterRun, MasterRunCreateInput, MasterStep, WorkspaceScope,
};

/// `Partial<MasterRun>` — `runs.store.ts:56`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunPatch {
    pub title: Option<String>,
    pub contract: Option<String>,
    pub status: Option<String>,
    pub progress: Option<i64>,
    pub verification_passed: Option<bool>,
    /// Outer `Some` is "present"; inner `None` is an explicit `null`.
    pub result_bundle: Option<Option<String>>,
    pub last_error: Option<Option<String>>,
    pub paused_for_approval: Option<bool>,
    pub pending_approval_action_type: Option<Option<String>>,
    pub cancelled_at: Option<Option<String>>,
    pub cancel_reason: Option<Option<String>>,
    pub owner_id: Option<Option<String>>,
    pub lease_expires_at: Option<Option<String>>,
    pub heartbeat_at: Option<Option<String>>,
}

/// `Omit<MasterStep, 'id' | 'createdAt' | 'updatedAt'>` — the columns the source reads.
pub struct MasterStepInput {
    pub seq: i64,
    pub phase: String,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
}

/// `Omit<MasterFeedback, 'id' | 'createdAt'>` — the columns the source reads.
pub struct MasterFeedbackInput {
    pub run_id: String,
    pub rating: i64,
    pub policy: String,
    pub comment: Option<String>,
}

/// `getRunRow` from `runs.store.ts:13-21`.
pub fn get_run_row(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<Option<MasterRun>> {
    let row = connection.query_row(
        "SELECT * FROM master_runs WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![run_id, scope.user_id, scope.workspace_id],
        to_run,
    );
    match row {
        Ok(run) => Ok(Some(run)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `getRun` from `runs.store.ts:36-39`.
pub fn get_run(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<Option<MasterRun>> {
    get_run_row(connection, scope, run_id)
}

/// `createRun` from `runs.store.ts:23-34`.
pub fn create_run(
    connection: &Connection,
    input: &MasterRunCreateInput,
) -> rusqlite::Result<MasterRun> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_runs (
           id, user_id, workspace_id, title, contract, status, progress, verification_passed,
           result_bundle, last_error, paused_for_approval, cancelled_at, cancel_reason,
           owner_id, lease_expires_at, heartbeat_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'ANALYZING', 0, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)",
        params![id, input.user_id, input.workspace_id, input.title, input.contract, now, now],
    )?;
    let scope = WorkspaceScope {
        user_id: input.user_id.clone(),
        workspace_id: input.workspace_id.clone(),
    };
    required(get_run(connection, &scope, &id)?)
}

/// `listRuns` from `runs.store.ts:41-50`.
pub fn list_runs(
    connection: &Connection,
    scope: &WorkspaceScope,
    limit: i64,
) -> rusqlite::Result<Vec<MasterRun>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_runs
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC LIMIT ?",
    )?;
    let rows = statement.query_map(params![scope.user_id, scope.workspace_id, limit], to_run)?;
    rows.collect()
}
/// `updateRun` from `runs.store.ts:52-94`.
pub fn update_run(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
    patch: &RunPatch,
) -> rusqlite::Result<Option<MasterRun>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(value) = &patch.title {
        push_text(&mut assignments, &mut values, "title", value);
    }
    if let Some(value) = &patch.contract {
        push_text(&mut assignments, &mut values, "contract", value);
    }
    if let Some(value) = &patch.status {
        push_text(&mut assignments, &mut values, "status", value);
    }
    if let Some(value) = patch.progress {
        assignments.push("progress = ?".to_string());
        values.push(Value::Integer(value));
    }
    if let Some(value) = patch.verification_passed {
        assignments.push("verification_passed = ?".to_string());
        values.push(Value::Integer(if value { 1 } else { 0 }));
    }
    if let Some(value) = &patch.result_bundle {
        push_optional_text(&mut assignments, &mut values, "result_bundle", value);
    }
    if let Some(value) = &patch.last_error {
        push_optional_text(&mut assignments, &mut values, "last_error", value);
    }
    if let Some(value) = patch.paused_for_approval {
        assignments.push("paused_for_approval = ?".to_string());
        values.push(Value::Integer(if value { 1 } else { 0 }));
    }
    if let Some(value) = &patch.pending_approval_action_type {
        push_optional_text(
            &mut assignments,
            &mut values,
            "pending_approval_action_type",
            value,
        );
    }
    if let Some(value) = &patch.cancelled_at {
        push_optional_text(&mut assignments, &mut values, "cancelled_at", value);
    }
    if let Some(value) = &patch.cancel_reason {
        push_optional_text(&mut assignments, &mut values, "cancel_reason", value);
    }
    if let Some(value) = &patch.owner_id {
        push_optional_text(&mut assignments, &mut values, "owner_id", value);
    }
    if let Some(value) = &patch.lease_expires_at {
        push_optional_text(&mut assignments, &mut values, "lease_expires_at", value);
    }
    if let Some(value) = &patch.heartbeat_at {
        push_optional_text(&mut assignments, &mut values, "heartbeat_at", value);
    }
    if assignments.is_empty() {
        return get_run(connection, scope, run_id);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(run_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_runs SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    get_run(connection, scope, run_id)
}

/// `claimRun` from `runs.store.ts:96-131`.
pub fn claim_run(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
    owner_id: &str,
    lease_expires_at: &str,
) -> rusqlite::Result<Option<MasterRun>> {
    let heartbeat_at = now_iso();
    let changes = connection.execute(
        "UPDATE master_runs
         SET owner_id = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ?
           AND (
             owner_id IS NULL
             OR owner_id = ?
             OR lease_expires_at IS NULL
             OR lease_expires_at <= ?
           )",
        params![
            owner_id,
            lease_expires_at,
            heartbeat_at,
            heartbeat_at,
            run_id,
            scope.user_id,
            scope.workspace_id,
            owner_id,
            heartbeat_at,
        ],
    )?;
    if changes == 0 {
        return Ok(None);
    }
    get_run(connection, scope, run_id)
}

/// `renewRunLease` from `runs.store.ts:133-152`.
pub fn renew_run_lease(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
    owner_id: &str,
    lease_expires_at: &str,
    heartbeat_at: &str,
) -> rusqlite::Result<Option<MasterRun>> {
    let changes = connection.execute(
        "UPDATE master_runs
         SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND owner_id = ?",
        params![
            lease_expires_at,
            heartbeat_at,
            heartbeat_at,
            run_id,
            scope.user_id,
            scope.workspace_id,
            owner_id,
        ],
    )?;
    if changes == 0 {
        return Ok(None);
    }
    get_run(connection, scope, run_id)
}

/// `releaseRunLease` from `runs.store.ts:154-172`.
pub fn release_run_lease(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
    owner_id: &str,
) -> rusqlite::Result<Option<MasterRun>> {
    let updated_at = now_iso();
    let changes = connection.execute(
        "UPDATE master_runs
         SET owner_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND user_id = ? AND workspace_id = ? AND owner_id = ?",
        params![
            updated_at,
            run_id,
            scope.user_id,
            scope.workspace_id,
            owner_id,
        ],
    )?;
    if changes == 0 {
        return Ok(None);
    }
    get_run(connection, scope, run_id)
}

/// `column = ?` for a required text column.
fn push_text(assignments: &mut Vec<String>, values: &mut Vec<Value>, column: &str, value: &str) {
    assignments.push(format!("{column} = ?"));
    values.push(Value::Text(value.to_string()));
}

/// `column = ?` for a nullable text column (`value ?? null`).
fn push_optional_text(
    assignments: &mut Vec<String>,
    values: &mut Vec<Value>,
    column: &str,
    value: &Option<String>,
) {
    assignments.push(format!("{column} = ?"));
    values.push(match value {
        Some(text) => Value::Text(text.clone()),
        None => Value::Null,
    });
}

/// `appendStep` from `runs.store.ts:174-204`.
pub fn append_step(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
    step: &MasterStepInput,
) -> rusqlite::Result<MasterStep> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_steps (
           id, run_id, user_id, workspace_id, seq, phase, status, input, output, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            run_id,
            scope.user_id,
            scope.workspace_id,
            step.seq,
            step.phase,
            step.status,
            step.input,
            step.output,
            now,
            now,
        ],
    )?;
    connection.query_row(
        "SELECT * FROM master_steps WHERE id = ?",
        params![id],
        to_step,
    )
}

/// `listSteps` from `runs.store.ts:206-215`.
pub fn list_steps(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<Vec<MasterStep>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_steps
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY seq ASC",
    )?;
    let rows = statement.query_map(params![scope.user_id, scope.workspace_id, run_id], to_step)?;
    rows.collect()
}

/// `addFeedback` from `runs.store.ts:217-242`.
pub fn add_feedback(
    connection: &Connection,
    scope: &WorkspaceScope,
    feedback: &MasterFeedbackInput,
) -> rusqlite::Result<MasterFeedback> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_iso();
    connection.execute(
        "INSERT OR REPLACE INTO master_feedback (id, run_id, user_id, workspace_id, rating, policy, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            feedback.run_id,
            scope.user_id,
            scope.workspace_id,
            feedback.rating,
            feedback.policy,
            feedback.comment,
            created_at,
        ],
    )?;
    connection.query_row(
        "SELECT * FROM master_feedback WHERE id = ?",
        params![id],
        to_feedback,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn setup() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        connection
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn create() -> (Connection, MasterRun) {
        let connection = setup();
        let run = create_run(
            &connection,
            &MasterRunCreateInput {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string(),
                title: "T".to_string(),
                contract: "C".to_string(),
            },
        )
        .unwrap();
        (connection, run)
    }

    #[test]
    fn create_run_starts_analyzing() {
        let (_connection, run) = create();
        assert_eq!(run.status, "ANALYZING");
        assert_eq!(run.progress, 0);
        assert!(!run.verification_passed);
        assert!(!run.paused_for_approval);
    }

    #[test]
    fn update_run_persists_booleans_as_integers() {
        let (connection, run) = create();
        let patch = RunPatch {
            status: Some("VERIFYING".to_string()),
            progress: Some(7),
            verification_passed: Some(true),
            paused_for_approval: Some(true),
            result_bundle: Some(None),
            ..RunPatch::default()
        };
        let updated = update_run(&connection, &scope(), &run.id, &patch)
            .unwrap()
            .unwrap();
        assert_eq!(updated.status, "VERIFYING");
        assert_eq!(updated.progress, 7);
        assert!(updated.verification_passed);
        assert!(updated.paused_for_approval);
        assert!(updated.result_bundle.is_none());
    }

    #[test]
    fn lease_claim_renew_release_semantics() {
        let (connection, run) = create();
        let claimed = claim_run(
            &connection,
            &scope(),
            &run.id,
            "o1",
            "2999-01-01T00:00:00.000Z",
        )
        .unwrap()
        .unwrap();
        assert_eq!(claimed.owner_id.as_deref(), Some("o1"));

        // A different owner cannot steal an unexpired lease.
        assert!(claim_run(
            &connection,
            &scope(),
            &run.id,
            "o2",
            "2999-01-01T00:00:00.000Z"
        )
        .unwrap()
        .is_none());

        // The holder can re-claim or renew.
        assert!(claim_run(
            &connection,
            &scope(),
            &run.id,
            "o1",
            "2999-01-01T00:00:00.000Z"
        )
        .unwrap()
        .is_some());
        assert!(renew_run_lease(
            &connection,
            &scope(),
            &run.id,
            "o1",
            "2999-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap()
        .is_some());
        // A non-holder cannot renew.
        assert!(renew_run_lease(
            &connection,
            &scope(),
            &run.id,
            "o2",
            "2999-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap()
        .is_none());

        let released = release_run_lease(&connection, &scope(), &run.id, "o1")
            .unwrap()
            .unwrap();
        assert!(released.owner_id.is_none());
        assert!(claim_run(
            &connection,
            &scope(),
            &run.id,
            "o2",
            "2999-01-01T00:00:00.000Z"
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn steps_are_listed_in_seq_order() {
        let (connection, run) = create();
        for seq in [2_i64, 1] {
            append_step(
                &connection,
                &scope(),
                &run.id,
                &MasterStepInput {
                    seq,
                    phase: "p".to_string(),
                    status: "pending".to_string(),
                    input: None,
                    output: None,
                },
            )
            .unwrap();
        }
        let steps = list_steps(&connection, &scope(), &run.id).unwrap();
        assert_eq!(
            steps.iter().map(|step| step.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn feedback_is_written_and_read_back() {
        let (connection, run) = create();
        let feedback = add_feedback(
            &connection,
            &scope(),
            &MasterFeedbackInput {
                run_id: run.id.clone(),
                rating: 4,
                policy: "balanced".to_string(),
                comment: None,
            },
        )
        .unwrap();
        assert_eq!(feedback.rating, 4);
        assert_eq!(feedback.policy, "balanced");
    }

    #[test]
    fn scope_isolation_hides_other_workspaces() {
        let (connection, run) = create();
        let other = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w2".to_string(),
        };
        assert!(get_run(&connection, &other, &run.id).unwrap().is_none());
    }
}
