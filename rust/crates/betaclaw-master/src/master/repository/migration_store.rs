//! Port of `src/server/master/repository/migration.store.ts:1-292`.
//!
//! The scope-migration engine: it discovers the known
//! `(user_id, workspace_id)` pairs across every master table
//! (`listAllKnownScopes`) and moves a whole scope to a new workspace id
//! (`migrateWorkspaceScope`), merging the three tables that carry a uniqueness
//! key so a moved row never violates it.
//!
//! # Statement parity
//!
//! * `listAllKnownScopes` builds one
//!   `SELECT user_id, workspace_id, MAX(<ts>) AS ts FROM <table> GROUP BY …`
//!   per `SCOPE_SOURCE_TABLES` entry, joins them with `UNION ALL`, and orders
//!   the outer `GROUP BY` by `MAX(ts) DESC LIMIT ?`.
//! * `migrateWorkspaceScope` runs inside one transaction: a plain
//!   `UPDATE <table> SET workspace_id = ? …` for every `SIMPLE_SCOPE_TABLES`
//!   entry, then the three merge helpers.
//! * The merge helpers pick the newer row with `Date.parse(a) > Date.parse(b)`;
//!   the port keeps JavaScript's `NaN` behaviour — an unparseable stamp never
//!   wins.
//!
//! `parsePersonaWorkspaceId`'s `/^persona:([^:]+):(.+)$/` is hand-written (no
//! `regex`) because it is one prefix, one delimiter and a non-empty tail.

use rusqlite::{params, Connection};

/// `SIMPLE_SCOPE_TABLES` from `migration.store.ts:3-18`.
const SIMPLE_SCOPE_TABLES: [&str; 14] = [
    "master_runs",
    "master_steps",
    "master_feedback",
    "master_notes",
    "master_reminders",
    "master_subagent_jobs",
    "master_subagent_events",
    "master_subagent_sessions",
    "master_action_ledger",
    "master_approval_requests",
    "master_tool_policies",
    "master_capability_proposals",
    "master_toolforge_artifacts",
    "master_audit_events",
];

/// `SCOPE_SOURCE_TABLES` from `migration.store.ts:20-38`.
const SCOPE_SOURCE_TABLES: [(&str, &str); 17] = [
    ("master_runs", "updated_at"),
    ("master_steps", "updated_at"),
    ("master_feedback", "created_at"),
    ("master_notes", "updated_at"),
    ("master_reminders", "updated_at"),
    ("master_subagent_jobs", "updated_at"),
    ("master_subagent_events", "created_at"),
    ("master_subagent_sessions", "updated_at"),
    ("master_action_ledger", "updated_at"),
    ("master_approval_requests", "updated_at"),
    ("master_approval_rules", "updated_at"),
    ("master_tool_policies", "updated_at"),
    ("master_capability_scores", "updated_at"),
    ("master_capability_proposals", "updated_at"),
    ("master_toolforge_artifacts", "updated_at"),
    ("master_connector_secrets", "updated_at"),
    ("master_audit_events", "created_at"),
];

/// `ScopeMigrationInput` from `migration.store.ts:40-44`.
pub struct ScopeMigrationInput<'a> {
    pub user_id: &'a str,
    pub from_workspace_id: &'a str,
    pub to_workspace_id: &'a str,
}

/// `Date.parse(value)` in milliseconds, or `None` for the `NaN` case.
fn js_date_parse(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|stamp| stamp.timestamp_millis())
}

/// `Date.parse(a) > Date.parse(b)` with JavaScript `NaN` semantics: an
/// unparseable stamp compares `false` on either side.
fn is_newer(left: &str, right: &str) -> bool {
    match (js_date_parse(left), js_date_parse(right)) {
        (Some(left), Some(right)) => left > right,
        _ => false,
    }
}

/// `!row.revoked_at` — `null`, `undefined` and the empty string are all "active".
fn is_active_revocation(revoked_at: Option<&str>) -> bool {
    match revoked_at {
        None => true,
        Some(value) => value.is_empty(),
    }
}

/// `parsePersonaWorkspaceId` from `migration.store.ts:286-292`.
///
/// `/^persona:([^:]+):(.+)$/` over the trimmed input.
fn parse_persona_workspace_id(workspace_id: &str) -> Option<(String, String)> {
    let trimmed = workspace_id.trim();
    let rest = trimmed.strip_prefix("persona:")?;
    let delimiter = rest.find(':')?;
    if delimiter == 0 {
        return None;
    }
    let persona_id = &rest[..delimiter];
    let inner = &rest[delimiter + 1..];
    if inner.is_empty() {
        return None;
    }
    Some((persona_id.to_string(), inner.to_string()))
}

/// `listAllKnownScopes` from `migration.store.ts:76-98`.
pub fn list_all_known_scopes(
    connection: &Connection,
    limit: i64,
) -> rusqlite::Result<Vec<(String, String)>> {
    let unions: Vec<String> = SCOPE_SOURCE_TABLES
        .iter()
        .map(|(table, timestamp_column)| {
            format!(
                "SELECT user_id, workspace_id, MAX({timestamp_column}) AS ts FROM {table} GROUP BY user_id, workspace_id"
            )
        })
        .collect();
    let sql = format!(
        "SELECT user_id, workspace_id FROM (
           {}
         )
         GROUP BY user_id, workspace_id
         ORDER BY MAX(ts) DESC
         LIMIT ?",
        unions.join("\nUNION ALL\n")
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![limit], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.collect()
}

/// `ApprovalRuleRow` from `migration.store.ts:46-53`.
struct ApprovalRuleRow {
    id: String,
    action_type: String,
    fingerprint: String,
    decision: String,
    created_at: String,
    updated_at: String,
}

fn read_approval_rule_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRuleRow> {
    Ok(ApprovalRuleRow {
        id: row.get("id")?,
        action_type: row.get("action_type")?,
        fingerprint: row.get("fingerprint")?,
        decision: row.get("decision")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `migrateUserLegacyScopesToMasterPersona` from `migration.store.ts:100-123`.
pub fn migrate_user_legacy_scopes_to_master_persona(
    connection: &Connection,
    user_id: &str,
    master_persona_id: &str,
) -> rusqlite::Result<usize> {
    let rows = list_all_known_scopes(connection, 10_000)?;
    let mut migrated_scopes = 0usize;
    for (row_user, workspace_id) in rows {
        if row_user != user_id {
            continue;
        }
        let Some((persona_id, inner)) = parse_persona_workspace_id(&workspace_id) else {
            continue;
        };
        if persona_id == master_persona_id {
            continue;
        }
        let to_workspace_id = format!("persona:{master_persona_id}:{inner}");
        migrate_workspace_scope(
            connection,
            &ScopeMigrationInput {
                user_id,
                from_workspace_id: &workspace_id,
                to_workspace_id: &to_workspace_id,
            },
        )?;
        migrated_scopes += 1;
    }
    Ok(migrated_scopes)
}

/// `migrateWorkspaceScope` from `migration.store.ts:125-143`.
pub fn migrate_workspace_scope(
    connection: &Connection,
    input: &ScopeMigrationInput<'_>,
) -> rusqlite::Result<()> {
    if input.from_workspace_id == input.to_workspace_id {
        return Ok(());
    }
    let transaction = connection.unchecked_transaction()?;
    for table in SIMPLE_SCOPE_TABLES {
        transaction.execute(
            &format!("UPDATE {table} SET workspace_id = ? WHERE user_id = ? AND workspace_id = ?"),
            params![
                input.to_workspace_id,
                input.user_id,
                input.from_workspace_id
            ],
        )?;
    }
    migrate_approval_rules(&transaction, input)?;
    migrate_capability_scores(&transaction, input)?;
    migrate_connector_secrets(&transaction, input)?;
    transaction.commit()?;
    Ok(())
}

/// `migrateApprovalRules` from `migration.store.ts:145-180`.
fn migrate_approval_rules(
    connection: &Connection,
    input: &ScopeMigrationInput<'_>,
) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;

    let old_rows = {
        let mut statement = connection.prepare(
            "SELECT * FROM master_approval_rules WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC",
        )?;
        let mapped = statement.query_map(
            params![input.user_id, input.from_workspace_id],
            read_approval_rule_row,
        )?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    for row in old_rows {
        let target = connection
            .query_row(
                "SELECT * FROM master_approval_rules
                 WHERE user_id = ? AND workspace_id = ? AND action_type = ? AND fingerprint = ? LIMIT 1",
                params![
                    input.user_id,
                    input.to_workspace_id,
                    row.action_type,
                    row.fingerprint
                ],
                read_approval_rule_row,
            )
            .optional()?;
        let Some(target) = target else {
            connection.execute(
                "UPDATE master_approval_rules SET workspace_id = ? WHERE id = ?",
                params![input.to_workspace_id, row.id],
            )?;
            continue;
        };
        if is_newer(&row.updated_at, &target.updated_at) {
            connection.execute(
                "UPDATE master_approval_rules
                 SET decision = ?, created_at = ?, updated_at = ?
                 WHERE id = ?",
                params![row.decision, row.created_at, row.updated_at, target.id],
            )?;
        }
        connection.execute(
            "DELETE FROM master_approval_rules WHERE id = ?",
            params![row.id],
        )?;
    }
    Ok(())
}

/// `CapabilityScoreRow` from `migration.store.ts:55-62`.
struct CapabilityScoreRow {
    id: String,
    capability: String,
    confidence: f64,
    last_verified_at: Option<String>,
    benchmark_summary: String,
    updated_at: String,
}

fn read_capability_score_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CapabilityScoreRow> {
    Ok(CapabilityScoreRow {
        id: row.get("id")?,
        capability: row.get("capability")?,
        confidence: row.get("confidence")?,
        last_verified_at: row.get("last_verified_at")?,
        benchmark_summary: row.get("benchmark_summary")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `ConnectorSecretRow` from `migration.store.ts:64-74`.
struct ConnectorSecretRow {
    id: String,
    provider: String,
    key_ref: String,
    encrypted_payload: String,
    issued_at: Option<String>,
    expires_at: Option<String>,
    revoked_at: Option<String>,
    created_at: String,
    updated_at: String,
}

fn read_connector_secret_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectorSecretRow> {
    Ok(ConnectorSecretRow {
        id: row.get("id")?,
        provider: row.get("provider")?,
        key_ref: row.get("key_ref")?,
        encrypted_payload: row.get("encrypted_payload")?,
        issued_at: row.get("issued_at")?,
        expires_at: row.get("expires_at")?,
        revoked_at: row.get("revoked_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `migrateCapabilityScores` from `migration.store.ts:182-223`.
fn migrate_capability_scores(
    connection: &Connection,
    input: &ScopeMigrationInput<'_>,
) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;

    let old_rows = {
        let mut statement = connection.prepare(
            "SELECT * FROM master_capability_scores
             WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC",
        )?;
        let mapped = statement.query_map(
            params![input.user_id, input.from_workspace_id],
            read_capability_score_row,
        )?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    for row in old_rows {
        let target = connection
            .query_row(
                "SELECT * FROM master_capability_scores
                 WHERE user_id = ? AND workspace_id = ? AND capability = ? LIMIT 1",
                params![input.user_id, input.to_workspace_id, row.capability],
                read_capability_score_row,
            )
            .optional()?;
        let Some(target) = target else {
            connection.execute(
                "UPDATE master_capability_scores SET workspace_id = ? WHERE id = ?",
                params![input.to_workspace_id, row.id],
            )?;
            continue;
        };
        if is_newer(&row.updated_at, &target.updated_at) {
            connection.execute(
                "UPDATE master_capability_scores
                 SET confidence = ?, last_verified_at = ?, benchmark_summary = ?, updated_at = ?
                 WHERE id = ?",
                params![
                    row.confidence,
                    row.last_verified_at,
                    row.benchmark_summary,
                    row.updated_at,
                    target.id
                ],
            )?;
        }
        connection.execute(
            "DELETE FROM master_capability_scores WHERE id = ?",
            params![row.id],
        )?;
    }
    Ok(())
}

/// `migrateConnectorSecrets` from `migration.store.ts:225-272`.
fn migrate_connector_secrets(
    connection: &Connection,
    input: &ScopeMigrationInput<'_>,
) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;

    let old_rows = {
        let mut statement = connection.prepare(
            "SELECT * FROM master_connector_secrets
             WHERE user_id = ? AND workspace_id = ? ORDER BY updated_at DESC",
        )?;
        let mapped = statement.query_map(
            params![input.user_id, input.from_workspace_id],
            read_connector_secret_row,
        )?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    for row in old_rows {
        let target = connection
            .query_row(
                "SELECT * FROM master_connector_secrets
                 WHERE user_id = ? AND workspace_id = ? AND provider = ? AND key_ref = ? LIMIT 1",
                params![
                    input.user_id,
                    input.to_workspace_id,
                    row.provider,
                    row.key_ref
                ],
                read_connector_secret_row,
            )
            .optional()?;
        let Some(target) = target else {
            connection.execute(
                "UPDATE master_connector_secrets SET workspace_id = ? WHERE id = ?",
                params![input.to_workspace_id, row.id],
            )?;
            continue;
        };
        if choose_connector_secret_winner(&row, &target) {
            connection.execute(
                "UPDATE master_connector_secrets
                 SET encrypted_payload = ?, issued_at = ?, expires_at = ?, revoked_at = ?, created_at = ?, updated_at = ?
                 WHERE id = ?",
                params![
                    row.encrypted_payload,
                    row.issued_at,
                    row.expires_at,
                    row.revoked_at,
                    row.created_at,
                    row.updated_at,
                    target.id
                ],
            )?;
        }
        connection.execute(
            "DELETE FROM master_connector_secrets WHERE id = ?",
            params![row.id],
        )?;
    }
    Ok(())
}

/// `chooseConnectorSecretWinner` from `migration.store.ts:274-284`.
///
/// Returns `true` when `left` (the outgoing row) wins over `right` (the target).
fn choose_connector_secret_winner(left: &ConnectorSecretRow, right: &ConnectorSecretRow) -> bool {
    let left_active = is_active_revocation(left.revoked_at.as_deref());
    let right_active = is_active_revocation(right.revoked_at.as_deref());
    if left_active != right_active {
        return left_active;
    }
    is_newer(&left.updated_at, &right.updated_at)
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

    fn insert_run(connection: &Connection, id: &str, workspace_id: &str, updated_at: &str) {
        connection
            .execute(
                "INSERT INTO master_runs (id, user_id, workspace_id, title, contract, status, progress,
                    verification_passed, paused_for_approval, created_at, updated_at)
                 VALUES (?, 'u1', ?, 'T', 'C', 'IDLE', 0, 0, 0, ?, ?)",
                params![id, workspace_id, updated_at, updated_at],
            )
            .unwrap();
    }

    #[test]
    fn parse_persona_workspace_id_matches_the_source_regex() {
        assert_eq!(
            parse_persona_workspace_id(" persona:p1:inner "),
            Some(("p1".to_string(), "inner".to_string()))
        );
        // The inner part may itself contain a colon.
        assert_eq!(
            parse_persona_workspace_id("persona:p1:a:b"),
            Some(("p1".to_string(), "a:b".to_string()))
        );
        assert_eq!(parse_persona_workspace_id("persona::inner"), None);
        assert_eq!(parse_persona_workspace_id("persona:p1:"), None);
        assert_eq!(parse_persona_workspace_id("plain"), None);
    }

    #[test]
    fn list_all_known_scopes_unions_the_tables() {
        let connection = setup();
        insert_run(&connection, "r1", "w1", "2026-01-01T00:00:00.000Z");
        let scopes = list_all_known_scopes(&connection, 500).unwrap();
        assert_eq!(scopes, vec![("u1".to_string(), "w1".to_string())]);
    }

    #[test]
    fn migrate_workspace_scope_moves_simple_tables() {
        let connection = setup();
        insert_run(&connection, "r1", "w1", "2026-01-01T00:00:00.000Z");
        migrate_workspace_scope(
            &connection,
            &ScopeMigrationInput {
                user_id: "u1",
                from_workspace_id: "w1",
                to_workspace_id: "w2",
            },
        )
        .unwrap();
        let moved: String = connection
            .query_row(
                "SELECT workspace_id FROM master_runs WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(moved, "w2");
    }

    #[test]
    fn migrate_user_legacy_scopes_rewrites_the_persona_segment() {
        let connection = setup();
        insert_run(
            &connection,
            "r1",
            "persona:old:main",
            "2026-01-01T00:00:00.000Z",
        );
        let migrated =
            migrate_user_legacy_scopes_to_master_persona(&connection, "u1", "master").unwrap();
        assert_eq!(migrated, 1);
        let workspace: String = connection
            .query_row(
                "SELECT workspace_id FROM master_runs WHERE id = 'r1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(workspace, "persona:master:main");
    }
}
