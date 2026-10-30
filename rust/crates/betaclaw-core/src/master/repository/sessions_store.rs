//! Port of `src/server/master/repository/sessions.store.ts:1-114`.
//!
//! Subagent sessions over `master_subagent_sessions`, scoped by
//! `(user_id, workspace_id)`. `createSubagentSession` writes the assigned tools
//! as JSON and reads the row back through `getSubagentSession` (the TypeScript
//! `!` becomes [`required`]).
//!
//! `updateSubagentSession` walks the source key→column map in order
//! (`status … lastError`); `assignedTools` is `JSON.stringify(rawValue ?? [])`
//! while every other key is `rawValue ?? null`.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_subagent_session;
use crate::master::repository::{push_optional_text, push_text, required};
use crate::master::types::{MasterSubagentSession, WorkspaceScope};

/// `Omit<MasterSubagentSession, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `sessions.store.ts:10`.
pub struct MasterSubagentSessionInput {
    pub run_id: String,
    pub status: String,
    pub title: String,
    pub prompt: String,
    pub assigned_tools: Vec<String>,
    pub owner_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub latest_event_at: Option<String>,
    pub result_summary: Option<String>,
    pub last_error: Option<String>,
}

/// `Partial<MasterSubagentSession>` — `sessions.store.ts:44`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubagentSessionPatch {
    pub status: Option<String>,
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub assigned_tools: Option<Vec<String>>,
    /// Outer `Some` is "present"; inner `None` is an explicit `null`.
    pub owner_id: Option<Option<String>>,
    pub lease_expires_at: Option<Option<String>>,
    pub heartbeat_at: Option<Option<String>>,
    pub latest_event_at: Option<Option<String>>,
    pub result_summary: Option<Option<String>>,
    pub last_error: Option<Option<String>>,
}

/// `createSubagentSession` from `sessions.store.ts:7-38`.
pub fn create_subagent_session(
    connection: &Connection,
    scope: &WorkspaceScope,
    session: &MasterSubagentSessionInput,
) -> rusqlite::Result<MasterSubagentSession> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let assigned_tools =
        serde_json::to_string(&session.assigned_tools).unwrap_or_else(|_| "[]".to_string());
    connection.execute(
        "INSERT INTO master_subagent_sessions (
           id, run_id, user_id, workspace_id, status, title, prompt, assigned_tools, owner_id,
           lease_expires_at, heartbeat_at, latest_event_at, result_summary, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            session.run_id,
            scope.user_id,
            scope.workspace_id,
            session.status,
            session.title,
            session.prompt,
            assigned_tools,
            session.owner_id,
            session.lease_expires_at,
            session.heartbeat_at,
            session.latest_event_at,
            session.result_summary,
            session.last_error,
            now,
            now,
        ],
    )?;
    required(get_subagent_session(connection, scope, &id)?)
}

/// `getSubagentSession` from `sessions.store.ts:76-88`.
pub fn get_subagent_session(
    connection: &Connection,
    scope: &WorkspaceScope,
    session_id: &str,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let row = connection.query_row(
        "SELECT * FROM master_subagent_sessions
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![session_id, scope.user_id, scope.workspace_id],
        to_subagent_session,
    );
    match row {
        Ok(session) => Ok(Some(session)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `updateSubagentSession` from `sessions.store.ts:40-74`.
pub fn update_subagent_session(
    connection: &Connection,
    scope: &WorkspaceScope,
    session_id: &str,
    patch: &SubagentSessionPatch,
) -> rusqlite::Result<Option<MasterSubagentSession>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(value) = &patch.status {
        push_text(&mut assignments, &mut values, "status", value);
    }
    if let Some(value) = &patch.title {
        push_text(&mut assignments, &mut values, "title", value);
    }
    if let Some(value) = &patch.prompt {
        push_text(&mut assignments, &mut values, "prompt", value);
    }
    if let Some(value) = &patch.assigned_tools {
        assignments.push("assigned_tools = ?".to_string());
        let encoded = serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string());
        values.push(Value::Text(encoded));
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
    if let Some(value) = &patch.latest_event_at {
        push_optional_text(&mut assignments, &mut values, "latest_event_at", value);
    }
    if let Some(value) = &patch.result_summary {
        push_optional_text(&mut assignments, &mut values, "result_summary", value);
    }
    if let Some(value) = &patch.last_error {
        push_optional_text(&mut assignments, &mut values, "last_error", value);
    }
    if assignments.is_empty() {
        return get_subagent_session(connection, scope, session_id);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(session_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_subagent_sessions SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    get_subagent_session(connection, scope, session_id)
}

/// `listSubagentSessions` from `sessions.store.ts:90-114`.
pub fn list_subagent_sessions(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<MasterSubagentSession>> {
    let (sql, values) = match run_id {
        Some(run_id) => (
            "SELECT * FROM master_subagent_sessions
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
            "SELECT * FROM master_subagent_sessions
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
    let rows = statement.query_map(params_from_iter(values), to_subagent_session)?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn setup() -> (Connection, WorkspaceScope) {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        let scope = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        };
        (connection, scope)
    }

    fn input() -> MasterSubagentSessionInput {
        MasterSubagentSessionInput {
            run_id: "r1".to_string(),
            status: "queued".to_string(),
            title: "T".to_string(),
            prompt: "P".to_string(),
            assigned_tools: vec!["shell".to_string()],
            owner_id: None,
            lease_expires_at: None,
            heartbeat_at: None,
            latest_event_at: None,
            result_summary: None,
            last_error: None,
        }
    }

    #[test]
    fn create_reads_back_assigned_tools_and_update_replaces_them() {
        let (connection, scope) = setup();
        let created = create_subagent_session(&connection, &scope, &input()).unwrap();
        assert_eq!(created.assigned_tools, vec!["shell".to_string()]);
        let updated = update_subagent_session(
            &connection,
            &scope,
            &created.id,
            &SubagentSessionPatch {
                status: Some("running".to_string()),
                assigned_tools: Some(vec!["read".to_string(), "write".to_string()]),
                owner_id: Some(Some("o1".to_string())),
                ..SubagentSessionPatch::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.status, "running");
        assert_eq!(
            updated.assigned_tools,
            vec!["read".to_string(), "write".to_string()]
        );
        assert_eq!(updated.owner_id.as_deref(), Some("o1"));

        assert_eq!(
            list_subagent_sessions(&connection, &scope, Some("r1"), 200)
                .unwrap()
                .len(),
            1
        );
        assert!(list_subagent_sessions(&connection, &scope, Some("r2"), 200)
            .unwrap()
            .is_empty());
    }
}
