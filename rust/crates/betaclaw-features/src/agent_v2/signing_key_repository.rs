//! Port of `src/server/agent-v2/repository/signingKeyRepository.ts`.
//!
//! Public keys and signature revocations. The stored values are public or
//! revocation markers only; no private key material passes through here.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::errors::AgentV2Error;
use super::types::{SigningKeyRecord, SigningKeyStatus, UpsertSigningKeyInput};
use super::utils::text_column;
use crate::stats::util::now_iso;

pub fn upsert_signing_key(
    connection: &Connection,
    input: &UpsertSigningKeyInput,
) -> Result<(), AgentV2Error> {
    let now = now_iso();
    let status = input.status.unwrap_or(SigningKeyStatus::Active);
    connection.execute(
        "INSERT INTO agent_v2_signing_keys (
           key_id, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id)
         DO UPDATE SET
           algorithm = excluded.algorithm,
           public_key_pem = excluded.public_key_pem,
           status = excluded.status,
           rotated_at = excluded.rotated_at,
           revoked_at = excluded.revoked_at",
        params![
            input.key_id,
            input.algorithm,
            input.public_key_pem,
            status.as_str(),
            now,
            input.rotated_at,
            input.revoked_at,
        ],
    )?;
    Ok(())
}

pub fn list_signing_keys(connection: &Connection) -> Result<Vec<SigningKeyRecord>, AgentV2Error> {
    let mut statement = connection.prepare("SELECT * FROM agent_v2_signing_keys")?;
    let mapped = statement.query_map([], |row| {
        Ok(SigningKeyRecord {
            key_id: row.get("key_id")?,
            algorithm: row.get("algorithm")?,
            public_key_pem: row.get("public_key_pem")?,
            status: text_column(row, "status", SigningKeyStatus::parse)?,
            created_at: row.get("created_at")?,
            rotated_at: row.get("rotated_at")?,
            revoked_at: row.get("revoked_at")?,
        })
    })?;
    Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `revokeSignature`: re-revoking the same digest replaces the reason and time.
pub fn revoke_signature(
    connection: &Connection,
    signature_digest: &str,
    reason: Option<&str>,
) -> Result<(), AgentV2Error> {
    let now = now_iso();
    connection.execute(
        "INSERT INTO agent_v2_revoked_signatures (signature_digest, reason, revoked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(signature_digest)
         DO UPDATE SET reason = excluded.reason, revoked_at = excluded.revoked_at",
        params![signature_digest, reason, now],
    )?;
    Ok(())
}

pub fn list_revoked_signature_digests(
    connection: &Connection,
) -> Result<HashSet<String>, AgentV2Error> {
    let mut statement =
        connection.prepare("SELECT signature_digest FROM agent_v2_revoked_signatures")?;
    let mapped = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(mapped.collect::<rusqlite::Result<HashSet<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::migrations::run_migrations;

    #[test]
    fn keys_and_revocations_round_trip() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("migrate");
        upsert_signing_key(
            &connection,
            &UpsertSigningKeyInput {
                key_id: "key-1".into(),
                algorithm: "RSA-SHA256".into(),
                public_key_pem: "-----BEGIN PUBLIC KEY-----".into(),
                status: None,
                rotated_at: None,
                revoked_at: None,
            },
        )
        .expect("insert key");

        let keys = list_signing_keys(&connection).expect("keys");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].status, SigningKeyStatus::Active);

        revoke_signature(&connection, "abc", Some("leaked")).expect("revoke");
        revoke_signature(&connection, "abc", None).expect("revoke again");
        let digests = list_revoked_signature_digests(&connection).expect("digests");
        assert!(digests.contains("abc"));
        assert_eq!(digests.len(), 1);
    }
}
