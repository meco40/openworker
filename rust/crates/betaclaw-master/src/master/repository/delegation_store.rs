//! Port of `src/server/master/repository/delegation.store.ts:1-139`.
//!
//! Subagent delegation jobs and their event stream, over
//! `master_subagent_jobs` / `master_subagent_events`, scoped by
//! `(user_id, workspace_id)`.
//!
//! `createDelegationJob` writes `attempts = 0` and `last_error = NULL` as
//! literals (`delegation.store.ts:25`) and then returns the row by scanning
//! `listDelegationJobs` for the new id; the port uses [`required`] on that
//! lookup. `appendDelegationEvent` returns an object literal without a
//! read-back, exactly like the source.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::{to_delegation_event, to_delegation_job};
use crate::master::repository::{push_optional_text, push_text, required};
use crate::master::types::{MasterDelegationEvent, MasterDelegationJob, WorkspaceScope};

/// `Omit<MasterDelegationJob, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'>`
/// — `delegation.store.ts:14-17`.
pub struct MasterDelegationJobInput {
    pub run_id: String,
    pub capability: String,
    pub payload: String,
    pub status: String,
    pub priority: String,
    pub max_attempts: i64,
    pub timeout_ms: i64,
}

/// `Partial<MasterDelegationJob>` — `delegation.store.ts:47`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DelegationPatch {
    pub status: Option<String>,
    pub attempts: Option<i64>,
    /// Outer `Some` is "present"; inner `None` is an explicit `null`.
    pub last_error: Option<Option<String>>,
    pub payload: Option<String>,
    pub priority: Option<String>,
    pub timeout_ms: Option<i64>,
    pub max_attempts: Option<i64>,
}

/// `Omit<MasterDelegationEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>`
/// — `delegation.store.ts:96`.
pub struct MasterDelegationEventInput {
    pub job_id: String,
    pub run_id: String,
    pub event_type: String,
    pub payload: String,
}

/// `createDelegationJob` from `delegation.store.ts:11-41`.
pub fn create_delegation_job(
    connection: &Connection,
    scope: &WorkspaceScope,
    job: &MasterDelegationJobInput,
) -> rusqlite::Result<MasterDelegationJob> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_subagent_jobs (
           id, run_id, user_id, workspace_id, capability, payload, status, priority,
           attempts, max_attempts, timeout_ms, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)",
        params![
            id,
            job.run_id,
            scope.user_id,
            scope.workspace_id,
            job.capability,
            job.payload,
            job.status,
            job.priority,
            job.max_attempts,
            job.timeout_ms,
            now,
            now,
        ],
    )?;
    let found = list_delegation_jobs(connection, scope, &job.run_id)?
        .into_iter()
        .find(|entry| entry.id == id);
    required(found)
}

/// `updateDelegationJob` from `delegation.store.ts:43-76`.
pub fn update_delegation_job(
    connection: &Connection,
    scope: &WorkspaceScope,
    job_id: &str,
    patch: &DelegationPatch,
) -> rusqlite::Result<Option<MasterDelegationJob>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(value) = &patch.status {
        push_text(&mut assignments, &mut values, "status", value);
    }
    if let Some(value) = patch.attempts {
        assignments.push("attempts = ?".to_string());
        values.push(Value::Integer(value));
    }
    if let Some(value) = &patch.last_error {
        push_optional_text(&mut assignments, &mut values, "last_error", value);
    }
    if let Some(value) = &patch.payload {
        push_text(&mut assignments, &mut values, "payload", value);
    }
    if let Some(value) = &patch.priority {
        push_text(&mut assignments, &mut values, "priority", value);
    }
    if let Some(value) = patch.timeout_ms {
        assignments.push("timeout_ms = ?".to_string());
        values.push(Value::Integer(value));
    }
    if let Some(value) = patch.max_attempts {
        assignments.push("max_attempts = ?".to_string());
        values.push(Value::Integer(value));
    }
    if assignments.is_empty() {
        return Ok(None);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(job_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_subagent_jobs SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    let row = connection.query_row(
        "SELECT * FROM master_subagent_jobs WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![job_id, scope.user_id, scope.workspace_id],
        to_delegation_job,
    );
    match row {
        Ok(job) => Ok(Some(job)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `listDelegationJobs` from `delegation.store.ts:78-91`.
pub fn list_delegation_jobs(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<Vec<MasterDelegationJob>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_subagent_jobs
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id, run_id],
        to_delegation_job,
    )?;
    rows.collect()
}

/// `appendDelegationEvent` from `delegation.store.ts:93-124`.
pub fn append_delegation_event(
    connection: &Connection,
    scope: &WorkspaceScope,
    event: &MasterDelegationEventInput,
) -> rusqlite::Result<MasterDelegationEvent> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_iso();
    connection.execute(
        "INSERT INTO master_subagent_events (
           id, job_id, run_id, user_id, workspace_id, type, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            event.job_id,
            event.run_id,
            scope.user_id,
            scope.workspace_id,
            event.event_type,
            event.payload,
            created_at,
        ],
    )?;
    Ok(MasterDelegationEvent {
        id,
        job_id: event.job_id.clone(),
        run_id: event.run_id.clone(),
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        event_type: event.event_type.clone(),
        payload: event.payload.clone(),
        created_at,
    })
}

/// `listDelegationEvents` from `delegation.store.ts:126-139`.
pub fn list_delegation_events(
    connection: &Connection,
    scope: &WorkspaceScope,
    run_id: &str,
) -> rusqlite::Result<Vec<MasterDelegationEvent>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_subagent_events
         WHERE user_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY created_at ASC",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id, run_id],
        to_delegation_event,
    )?;
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

    fn job_input() -> MasterDelegationJobInput {
        MasterDelegationJobInput {
            run_id: "r1".to_string(),
            capability: "cap".to_string(),
            payload: "p".to_string(),
            status: "queued".to_string(),
            priority: "high".to_string(),
            max_attempts: 3,
            timeout_ms: 120_000,
        }
    }

    #[test]
    fn create_job_defaults_attempts_and_null_error() {
        let (connection, scope) = setup();
        let job = create_delegation_job(&connection, &scope, &job_input()).unwrap();
        assert_eq!(job.attempts, 0);
        assert!(job.last_error.is_none());
        assert_eq!(job.max_attempts, 3);
    }

    #[test]
    fn update_and_event_stream() {
        let (connection, scope) = setup();
        let job = create_delegation_job(&connection, &scope, &job_input()).unwrap();
        let updated = update_delegation_job(
            &connection,
            &scope,
            &job.id,
            &DelegationPatch {
                status: Some("running".to_string()),
                attempts: Some(1),
                ..DelegationPatch::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.status, "running");
        assert_eq!(updated.attempts, 1);

        append_delegation_event(
            &connection,
            &scope,
            &MasterDelegationEventInput {
                job_id: job.id.clone(),
                run_id: "r1".to_string(),
                event_type: "started".to_string(),
                payload: "{}".to_string(),
            },
        )
        .unwrap();
        let events = list_delegation_events(&connection, &scope, "r1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "started");
    }
}
