//! Port of `src/server/master/repository/audit.store.ts:1-52`.
//!
//! Append + list over `master_audit_events`, scoped by
//! `(user_id, workspace_id)`. Unlike the other stores, `appendAuditEvent`
//! returns the row it just wrote without a follow-up `SELECT` — the port keeps
//! that and builds the same object literal (`audit.store.ts:27-35`).

use rusqlite::{params, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_audit_event;
use crate::master::types::{MasterAuditEvent, WorkspaceScope};

/// `Omit<MasterAuditEvent, 'id' | 'userId' | 'workspaceId' | 'createdAt'>` —
/// `audit.store.ts:10`.
pub struct MasterAuditEventInput {
    pub category: String,
    pub action: String,
    pub metadata: String,
}

/// `appendAuditEvent` from `audit.store.ts:7-36`.
pub fn append_audit_event(
    connection: &Connection,
    scope: &WorkspaceScope,
    input: &MasterAuditEventInput,
) -> rusqlite::Result<MasterAuditEvent> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = now_iso();
    connection.execute(
        "INSERT INTO master_audit_events (
           id, user_id, workspace_id, category, action, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            scope.user_id,
            scope.workspace_id,
            input.category,
            input.action,
            input.metadata,
            created_at,
        ],
    )?;
    Ok(MasterAuditEvent {
        id,
        user_id: scope.user_id.clone(),
        workspace_id: scope.workspace_id.clone(),
        category: input.category.clone(),
        action: input.action.clone(),
        metadata: input.metadata.clone(),
        created_at,
    })
}

/// `listAuditEvents` from `audit.store.ts:38-52`.
pub fn list_audit_events(
    connection: &Connection,
    scope: &WorkspaceScope,
    limit: i64,
) -> rusqlite::Result<Vec<MasterAuditEvent>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_audit_events
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id, limit],
        to_audit_event,
    )?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn append_returns_the_written_row_and_list_reads_it_back() {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        let appended = append_audit_event(
            &connection,
            &scope(),
            &MasterAuditEventInput {
                category: "run".to_string(),
                action: "created".to_string(),
                metadata: "{}".to_string(),
            },
        )
        .unwrap();
        assert_eq!(appended.user_id, "u1");
        let listed = list_audit_events(&connection, &scope(), 200).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, appended.id);
        assert_eq!(listed[0].metadata, "{}");
    }
}
