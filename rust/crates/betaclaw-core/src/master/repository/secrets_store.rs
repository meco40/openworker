//! Port of `src/server/master/repository/secrets.store.ts:1-53`.
//!
//! Connector secrets over `master_connector_secrets`, keyed by
//! `(user_id, workspace_id, provider, key_ref)`. `upsertConnectorSecret` relies
//! on the table's `UNIQUE` constraint with
//! `ON CONFLICT(...) DO UPDATE SET …` and then re-reads through
//! `getConnectorSecret` (the TypeScript `!` becomes [`required`]).

use rusqlite::{params, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_connector_secret;
use crate::master::repository::required;
use crate::master::types::{MasterConnectorSecret, WorkspaceScope};

/// `Omit<MasterConnectorSecret, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `secrets.store.ts:10`.
pub struct MasterConnectorSecretInput {
    pub provider: String,
    pub key_ref: String,
    pub encrypted_payload: String,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// `upsertConnectorSecret` from `secrets.store.ts:7-38`.
pub fn upsert_connector_secret(
    connection: &Connection,
    scope: &WorkspaceScope,
    secret: &MasterConnectorSecretInput,
) -> rusqlite::Result<MasterConnectorSecret> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_connector_secrets (
           id, user_id, workspace_id, provider, key_ref, encrypted_payload, issued_at, expires_at, revoked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, provider, key_ref)
         DO UPDATE SET
           encrypted_payload = excluded.encrypted_payload,
           issued_at = excluded.issued_at,
           expires_at = excluded.expires_at,
           revoked_at = excluded.revoked_at,
           updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            scope.user_id,
            scope.workspace_id,
            secret.provider,
            secret.key_ref,
            secret.encrypted_payload,
            secret.issued_at,
            secret.expires_at,
            secret.revoked_at,
            now,
            now,
        ],
    )?;
    required(get_connector_secret(
        connection,
        scope,
        &secret.provider,
        &secret.key_ref,
    )?)
}

/// `getConnectorSecret` from `secrets.store.ts:40-53`.
pub fn get_connector_secret(
    connection: &Connection,
    scope: &WorkspaceScope,
    provider: &str,
    key_ref: &str,
) -> rusqlite::Result<Option<MasterConnectorSecret>> {
    let row = connection.query_row(
        "SELECT * FROM master_connector_secrets
         WHERE user_id = ? AND workspace_id = ? AND provider = ? AND key_ref = ?",
        params![scope.user_id, scope.workspace_id, provider, key_ref],
        to_connector_secret,
    );
    match row {
        Ok(secret) => Ok(Some(secret)),
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

    fn input(payload: &str) -> MasterConnectorSecretInput {
        MasterConnectorSecretInput {
            provider: "gmail".to_string(),
            key_ref: "default".to_string(),
            encrypted_payload: payload.to_string(),
            issued_at: None,
            expires_at: None,
            revoked_at: None,
        }
    }

    #[test]
    fn upsert_updates_the_existing_row() {
        let (connection, scope) = setup();
        let first = upsert_connector_secret(&connection, &scope, &input("one")).unwrap();
        let second = upsert_connector_secret(&connection, &scope, &input("two")).unwrap();
        // The unique key is (user, workspace, provider, key_ref), so the second
        // write must update in place rather than insert a new row.
        assert_eq!(second.encrypted_payload, "two");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM master_connector_secrets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(first.provider, "gmail");
    }
}
