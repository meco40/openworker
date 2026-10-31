//! Port of `src/server/master/repository/toolPolicy.store.ts:1-45`.
//!
//! One tool policy per `(user_id, workspace_id)`. `upsertToolPolicy` writes the
//! allowlist as JSON (`JSON.stringify(policy.allowlist ?? [])`) and uses the
//! table's `UNIQUE (user_id, workspace_id)` constraint with
//! `ON CONFLICT(...) DO UPDATE`; `getToolPolicy` reads it back with `LIMIT 1`.

use rusqlite::{params, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_tool_policy;
use crate::master::repository::required;
use crate::master::types::{MasterToolPolicy, WorkspaceScope};

/// `Omit<MasterToolPolicy, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `toolPolicy.store.ts:10`.
pub struct MasterToolPolicyInput {
    pub security: String,
    pub ask: String,
    pub allowlist: Vec<String>,
    pub updated_by: Option<String>,
}

/// `upsertToolPolicy` from `toolPolicy.store.ts:7-35`.
pub fn upsert_tool_policy(
    connection: &Connection,
    scope: &WorkspaceScope,
    policy: &MasterToolPolicyInput,
) -> rusqlite::Result<MasterToolPolicy> {
    let now = now_iso();
    let allowlist = serde_json::to_string(&policy.allowlist).unwrap_or_else(|_| "[]".to_string());
    connection.execute(
        "INSERT INTO master_tool_policies (
           id, user_id, workspace_id, security, ask, allowlist, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id) DO UPDATE SET
           security = excluded.security,
           ask = excluded.ask,
           allowlist = excluded.allowlist,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            scope.user_id,
            scope.workspace_id,
            policy.security,
            policy.ask,
            allowlist,
            policy.updated_by,
            now,
            now,
        ],
    )?;
    required(get_tool_policy(connection, scope)?)
}

/// `getToolPolicy` from `toolPolicy.store.ts:37-45`.
pub fn get_tool_policy(
    connection: &Connection,
    scope: &WorkspaceScope,
) -> rusqlite::Result<Option<MasterToolPolicy>> {
    let row = connection.query_row(
        "SELECT * FROM master_tool_policies
         WHERE user_id = ? AND workspace_id = ? LIMIT 1",
        params![scope.user_id, scope.workspace_id],
        to_tool_policy,
    );
    match row {
        Ok(policy) => Ok(Some(policy)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
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

    #[test]
    fn upsert_replaces_the_single_policy_and_round_trips_the_allowlist() {
        let (connection, scope) = setup();
        upsert_tool_policy(
            &connection,
            &scope,
            &MasterToolPolicyInput {
                security: "allowlist".to_string(),
                ask: "on_miss".to_string(),
                allowlist: vec!["shell".to_string(), "read".to_string()],
                updated_by: None,
            },
        )
        .unwrap();
        let policy = upsert_tool_policy(
            &connection,
            &scope,
            &MasterToolPolicyInput {
                security: "full".to_string(),
                ask: "off".to_string(),
                allowlist: vec!["shell".to_string()],
                updated_by: Some("u1".to_string()),
            },
        )
        .unwrap();
        assert_eq!(policy.security, "full");
        assert_eq!(policy.allowlist, vec!["shell".to_string()]);
        assert_eq!(policy.updated_by.as_deref(), Some("u1"));
    }
}
