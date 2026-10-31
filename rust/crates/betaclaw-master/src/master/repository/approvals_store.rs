//! Port of `src/server/master/repository/approvals.store.ts:1-124`.
//!
//! CRUD over `master_approval_requests`, scoped by `(user_id, workspace_id)`.
//! The insert writes 21 columns in the source's order; `createApprovalRequest`
//! returns the row it just wrote through a `getApprovalRequest` read-back (the
//! TypeScript `!` becomes [`required`]).
//!
//! `updateApprovalRequest` walks the fixed key→column map in source order
//! (`stepId … decidedAt`); an empty patch is not a no-op name but a plain
//! `getApprovalRequest` call, exactly like `approvals.store.ts:76`.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_approval_request;
use crate::master::repository::required;
use crate::master::types::{MasterApprovalRequest, WorkspaceScope};

/// `Omit<MasterApprovalRequest, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `approvals.store.ts:10`.
pub struct MasterApprovalRequestInput {
    pub run_id: String,
    pub step_id: String,
    pub tool_name: String,
    pub action_type: String,
    pub summary: String,
    pub prompt: String,
    pub host: Option<String>,
    pub cwd: Option<String>,
    pub resolved_path: Option<String>,
    pub fingerprint: String,
    pub risk_level: String,
    pub status: String,
    pub expires_at: String,
    pub decision: Option<String>,
    pub decision_reason: Option<String>,
    pub decided_at: Option<String>,
}

/// `Partial<MasterApprovalRequest>` — `approvals.store.ts:50`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApprovalPatch {
    pub step_id: Option<String>,
    pub tool_name: Option<String>,
    pub action_type: Option<String>,
    pub summary: Option<String>,
    pub prompt: Option<String>,
    /// Outer `Some` is "present"; inner `None` is an explicit `null`.
    pub host: Option<Option<String>>,
    pub cwd: Option<Option<String>>,
    pub resolved_path: Option<Option<String>>,
    pub fingerprint: Option<String>,
    pub risk_level: Option<String>,
    pub status: Option<String>,
    pub expires_at: Option<String>,
    pub decision: Option<Option<String>>,
    pub decision_reason: Option<Option<String>>,
    pub decided_at: Option<Option<String>>,
}

/// `getApprovalRequest` from `approvals.store.ts:86-98`.
pub fn get_approval_request(
    connection: &Connection,
    scope: &WorkspaceScope,
    request_id: &str,
) -> rusqlite::Result<Option<MasterApprovalRequest>> {
    let row = connection.query_row(
        "SELECT * FROM master_approval_requests
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![request_id, scope.user_id, scope.workspace_id],
        to_approval_request,
    );
    match row {
        Ok(request) => Ok(Some(request)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `createApprovalRequest` from `approvals.store.ts:7-44`.
pub fn create_approval_request(
    connection: &Connection,
    scope: &WorkspaceScope,
    request: &MasterApprovalRequestInput,
) -> rusqlite::Result<MasterApprovalRequest> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_approval_requests (
           id, run_id, step_id, user_id, workspace_id, tool_name, action_type, summary, prompt, host,
           cwd, resolved_path, fingerprint, risk_level, status, expires_at, decision, decision_reason,
           decided_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            request.run_id,
            request.step_id,
            scope.user_id,
            scope.workspace_id,
            request.tool_name,
            request.action_type,
            request.summary,
            request.prompt,
            request.host,
            request.cwd,
            request.resolved_path,
            request.fingerprint,
            request.risk_level,
            request.status,
            request.expires_at,
            request.decision,
            request.decision_reason,
            request.decided_at,
            now,
            now,
        ],
    )?;
    required(get_approval_request(connection, scope, &id)?)
}
/// `listApprovalRequests` from `approvals.store.ts:100-124`.
///
/// With a `run_id` the source uses the narrower query; without one it uses the
/// scope-only query. Both end with `ORDER BY updated_at DESC LIMIT ?`.
pub fn list_approval_requests(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<MasterApprovalRequest>> {
    let (sql, values) = match run_id {
        Some(run_id) => (
            "SELECT * FROM master_approval_requests
             WHERE user_id = ? AND workspace_id = ? AND run_id = ?
             ORDER BY updated_at DESC LIMIT ?",
            vec![
                Value::Text(scope.user_id.clone()),
                Value::Text(scope.workspace_id.clone()),
                Value::Text(run_id.to_string()),
                Value::Integer(limit),
            ],
        ),
        None => (
            "SELECT * FROM master_approval_requests
             WHERE user_id = ? AND workspace_id = ?
             ORDER BY updated_at DESC LIMIT ?",
            vec![
                Value::Text(scope.user_id.clone()),
                Value::Text(scope.workspace_id.clone()),
                Value::Integer(limit),
            ],
        ),
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params_from_iter(values), to_approval_request)?;
    rows.collect()
}

/// `value ?? null` for a nullable text column.
fn optional_text(value: &Option<String>) -> Value {
    match value {
        Some(text) => Value::Text(text.clone()),
        None => Value::Null,
    }
}

/// `updateApprovalRequest` from `approvals.store.ts:46-84`.
pub fn update_approval_request(
    connection: &Connection,
    scope: &WorkspaceScope,
    request_id: &str,
    patch: &ApprovalPatch,
) -> rusqlite::Result<Option<MasterApprovalRequest>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(value) = &patch.step_id {
        push_text(&mut assignments, &mut values, "step_id", value);
    }
    if let Some(value) = &patch.tool_name {
        push_text(&mut assignments, &mut values, "tool_name", value);
    }
    if let Some(value) = &patch.action_type {
        push_text(&mut assignments, &mut values, "action_type", value);
    }
    if let Some(value) = &patch.summary {
        push_text(&mut assignments, &mut values, "summary", value);
    }
    if let Some(value) = &patch.prompt {
        push_text(&mut assignments, &mut values, "prompt", value);
    }
    if let Some(value) = &patch.host {
        push_optional(&mut assignments, &mut values, "host", value);
    }
    if let Some(value) = &patch.cwd {
        push_optional(&mut assignments, &mut values, "cwd", value);
    }
    if let Some(value) = &patch.resolved_path {
        push_optional(&mut assignments, &mut values, "resolved_path", value);
    }
    if let Some(value) = &patch.fingerprint {
        push_text(&mut assignments, &mut values, "fingerprint", value);
    }
    if let Some(value) = &patch.risk_level {
        push_text(&mut assignments, &mut values, "risk_level", value);
    }
    if let Some(value) = &patch.status {
        push_text(&mut assignments, &mut values, "status", value);
    }
    if let Some(value) = &patch.expires_at {
        push_text(&mut assignments, &mut values, "expires_at", value);
    }
    if let Some(value) = &patch.decision {
        push_optional(&mut assignments, &mut values, "decision", value);
    }
    if let Some(value) = &patch.decision_reason {
        push_optional(&mut assignments, &mut values, "decision_reason", value);
    }
    if let Some(value) = &patch.decided_at {
        push_optional(&mut assignments, &mut values, "decided_at", value);
    }
    if assignments.is_empty() {
        return get_approval_request(connection, scope, request_id);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(request_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_approval_requests SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    get_approval_request(connection, scope, request_id)
}

/// `column = ?` for a required text column.
fn push_text(assignments: &mut Vec<String>, values: &mut Vec<Value>, column: &str, value: &str) {
    assignments.push(format!("{column} = ?"));
    values.push(Value::Text(value.to_string()));
}

/// `column = ?` for a nullable text column (`value ?? null`).
fn push_optional(
    assignments: &mut Vec<String>,
    values: &mut Vec<Value>,
    column: &str,
    value: &Option<String>,
) {
    assignments.push(format!("{column} = ?"));
    values.push(optional_text(value));
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

    fn input() -> MasterApprovalRequestInput {
        MasterApprovalRequestInput {
            run_id: "r1".to_string(),
            step_id: "s1".to_string(),
            tool_name: "shell".to_string(),
            action_type: "exec".to_string(),
            summary: "sum".to_string(),
            prompt: "prompt".to_string(),
            host: Some("gateway".to_string()),
            cwd: None,
            resolved_path: None,
            fingerprint: "fp".to_string(),
            risk_level: "medium".to_string(),
            status: "pending".to_string(),
            expires_at: "2026-01-01T00:00:00.000Z".to_string(),
            decision: None,
            decision_reason: None,
            decided_at: None,
        }
    }

    #[test]
    fn create_reads_back_and_update_applies_decision() {
        let connection = setup();
        let created = create_approval_request(&connection, &scope(), &input()).unwrap();
        assert_eq!(created.host.as_deref(), Some("gateway"));
        let found = get_approval_request(&connection, &scope(), &created.id)
            .unwrap()
            .unwrap();
        assert_eq!(found.id, created.id);

        let patch = ApprovalPatch {
            status: Some("approved".to_string()),
            decision: Some(Some("approve_once".to_string())),
            decided_at: Some(Some("2026-01-02T00:00:00.000Z".to_string())),
            ..ApprovalPatch::default()
        };
        let updated = update_approval_request(&connection, &scope(), &created.id, &patch)
            .unwrap()
            .unwrap();
        assert_eq!(updated.status, "approved");
        assert_eq!(updated.decision.as_deref(), Some("approve_once"));
    }

    #[test]
    fn empty_patch_is_a_plain_read() {
        let connection = setup();
        let created = create_approval_request(&connection, &scope(), &input()).unwrap();
        let unchanged = update_approval_request(
            &connection,
            &scope(),
            &created.id,
            &ApprovalPatch::default(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(unchanged.id, created.id);
        assert_eq!(unchanged.status, "pending");
    }

    #[test]
    fn list_filters_by_run_when_given() {
        let connection = setup();
        create_approval_request(&connection, &scope(), &input()).unwrap();
        let all = list_approval_requests(&connection, &scope(), None, 200).unwrap();
        assert_eq!(all.len(), 1);
        let by_run = list_approval_requests(&connection, &scope(), Some("r1"), 200).unwrap();
        assert_eq!(by_run.len(), 1);
        let other = list_approval_requests(&connection, &scope(), Some("r2"), 200).unwrap();
        assert!(other.is_empty());
    }
}
