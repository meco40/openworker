//! Port of `src/server/master/repository/scopes.store.ts:1-9`.
//!
//! A one-line wrapper: `listAllKnownScopes` (see [`super::migration_store`])
//! returns raw `{ user_id, workspace_id }` rows and this module maps them through
//! `toWorkspaceScope`. Because the source rows already carry both fields as
//! strings, the mapping is the direct construction of
//! [`WorkspaceScope`](crate::master::types::WorkspaceScope).

use rusqlite::Connection;

use crate::master::repository::migration_store::list_all_known_scopes;
use crate::master::types::WorkspaceScope;

/// `listKnownScopes` from `scopes.store.ts:6-9`.
pub fn list_known_scopes(
    connection: &Connection,
    limit: i64,
) -> rusqlite::Result<Vec<WorkspaceScope>> {
    let rows = list_all_known_scopes(connection, limit)?;
    Ok(rows
        .into_iter()
        .map(|(user_id, workspace_id)| WorkspaceScope {
            user_id,
            workspace_id,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    #[test]
    fn lists_the_scopes_of_the_master_tables() {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO master_notes (id, user_id, workspace_id, title, content, tags, created_at, updated_at)
                 VALUES ('n1', 'u1', 'w1', 'T', 'B', '[]', 't0', 't1')",
                [],
            )
            .unwrap();
        let scopes = list_known_scopes(&connection, 500).unwrap();
        assert_eq!(
            scopes,
            vec![WorkspaceScope {
                user_id: "u1".to_string(),
                workspace_id: "w1".to_string()
            }]
        );
    }
}
