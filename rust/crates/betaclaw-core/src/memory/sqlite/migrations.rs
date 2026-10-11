//! Port of the `migrate()` ladder of
//! `src/server/memory/sqliteMemoryRepository.ts:61-118`.
//!
//! # Statement-for-statement parity
//!
//! The TypeScript source has no migration ledger. It is a ladder of idempotent
//! DDL plus a `PRAGMA table_info` probe before each `ALTER TABLE`, executed in
//! this order:
//!
//! 1. `CREATE TABLE IF NOT EXISTS memory_nodes`
//! 2. `CREATE TABLE IF NOT EXISTS memory_node_history` and its index
//! 3. `ALTER TABLE memory_nodes ADD COLUMN persona_id` — only when absent
//! 4. `ALTER TABLE memory_nodes ADD COLUMN user_id` — only when absent
//! 5. Two backfill `UPDATE`s
//! 6. `CREATE INDEX idx_memory_importance`
//! 7. `CREATE INDEX idx_memory_persona`
//!
//! Statements 3 and 4 are the migration freshness path: a database written by a
//! release before the persona column existed still upgrades, and the backfill
//! in 5 then fills `persona_id = 'persona-default'` and
//! `user_id = '<LEGACY_LOCAL_USER_ID>'`. The port reproduces the order exactly,
//! because reordering 5 before 3/4 would address a column that does not exist
//! yet.
//!
//! # Shared file
//!
//! `memory_nodes` and `memory_node_history` live in the same
//! `.local/messages.db` that carries the seven tables of the messages store.
//! The ladder therefore only ever adds, and the queries only ever name their own
//! two tables.

use rusqlite::Connection;

use crate::memory::types::LEGACY_LOCAL_USER_ID;

/// `hasColumn` from `sqliteMemoryRepository.ts:125-130`.
///
/// The probe reads `PRAGMA table_info(<table>)` and compares the `name` column.
pub fn has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: Option<String> = row.get(1)?;
        if name.as_deref() == Some(column_name) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `SqliteMemoryRepository.migrate()` from `sqliteMemoryRepository.ts:61-118`.
///
/// Runs unconditionally on open, exactly like the source, and is safe to call
/// repeatedly.
pub fn run_migrations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_nodes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding_json TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL,
          confidence REAL NOT NULL,
          timestamp TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
    "#,
    )?;

    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_node_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id TEXT NOT NULL,
          action TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_memory_history_node
          ON memory_node_history (node_id, id);
    "#,
    )?;

    if !has_column(connection, "memory_nodes", "persona_id")? {
        connection.execute_batch(
            "ALTER TABLE memory_nodes ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'persona-default';",
        )?;
    }
    if !has_column(connection, "memory_nodes", "user_id")? {
        connection.execute_batch(&format!(
            "ALTER TABLE memory_nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT '{LEGACY_LOCAL_USER_ID}';"
        ))?;
    }

    connection.execute_batch(
        r#"
        UPDATE memory_nodes
        SET persona_id = 'persona-default'
        WHERE persona_id IS NULL OR TRIM(persona_id) = '';
    "#,
    )?;
    connection.execute_batch(&format!(
        r#"
        UPDATE memory_nodes
        SET user_id = '{LEGACY_LOCAL_USER_ID}'
        WHERE user_id IS NULL OR TRIM(user_id) = '';
    "#
    ))?;

    connection.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memory_importance
          ON memory_nodes (user_id, persona_id, importance DESC, updated_at DESC);
    "#,
    )?;
    connection.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memory_persona
          ON memory_nodes (user_id, updated_at DESC);
    "#,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};

    fn connection() -> Connection {
        open(OpenOptions::new(":memory:")).expect("open in-memory database")
    }

    /// A fresh database must end up with the full column set, exactly the set
    /// the `CREATE TABLE` declares — because both `ALTER TABLE` probes find
    /// their column and are skipped.
    #[test]
    fn a_fresh_database_creates_both_tables_with_the_full_column_set() {
        let connection = connection();
        run_migrations(&connection).expect("migrate");

        for column in [
            "id",
            "user_id",
            "persona_id",
            "type",
            "content",
            "embedding_json",
            "importance",
            "confidence",
            "timestamp",
            "metadata_json",
            "created_at",
            "updated_at",
        ] {
            assert!(
                has_column(&connection, "memory_nodes", column).expect("probe"),
                "memory_nodes.{column} must exist on a fresh database"
            );
        }
        for column in [
            "id",
            "node_id",
            "action",
            "timestamp",
            "content",
            "metadata_json",
        ] {
            assert!(
                has_column(&connection, "memory_node_history", column).expect("probe"),
                "memory_node_history.{column} must exist on a fresh database"
            );
        }

        let index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_memory%'",
                [],
                |row| row.get(0),
            )
            .expect("count indexes");
        assert_eq!(index_count, 3, "history, importance and persona indexes");
    }

    /// Migration freshness from an *old* schema: the pre-persona release created
    /// the table without `persona_id` and `user_id`. The ladder adds both and
    /// the backfill fills a value into every existing row.
    #[test]
    fn an_old_schema_without_the_scope_columns_is_upgraded_and_backfilled() {
        let connection = connection();
        connection
            .execute_batch(
                r#"
                CREATE TABLE memory_nodes (
                  id TEXT PRIMARY KEY,
                  type TEXT NOT NULL,
                  content TEXT NOT NULL,
                  embedding_json TEXT NOT NULL DEFAULT '[]',
                  importance INTEGER NOT NULL,
                  confidence REAL NOT NULL,
                  timestamp TEXT NOT NULL,
                  metadata_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO memory_nodes
                  (id, type, content, importance, confidence, timestamp, created_at, updated_at)
                VALUES ('m-1', 'fact', 'legacy row', 3, 0.3, 't0', 't0', 't0');
                "#,
            )
            .expect("seed legacy schema");

        run_migrations(&connection).expect("migrate");

        assert!(has_column(&connection, "memory_nodes", "persona_id").expect("probe"));
        assert!(has_column(&connection, "memory_nodes", "user_id").expect("probe"));

        let (persona_id, user_id): (String, String) = connection
            .query_row(
                "SELECT persona_id, user_id FROM memory_nodes WHERE id = 'm-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read backfilled row");
        assert_eq!(persona_id, "persona-default");
        assert_eq!(user_id, LEGACY_LOCAL_USER_ID);
    }

    /// The backfill is idempotent and must not overwrite a real scope: an
    /// already-scoped legacy row keeps its ids.
    #[test]
    fn the_backfill_leaves_an_already_scoped_row_alone() {
        let connection = connection();
        connection
            .execute_batch(
                r#"
                CREATE TABLE memory_nodes (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL DEFAULT 'legacy-local-user',
                  persona_id TEXT NOT NULL DEFAULT 'persona-default',
                  type TEXT NOT NULL,
                  content TEXT NOT NULL,
                  embedding_json TEXT NOT NULL DEFAULT '[]',
                  importance INTEGER NOT NULL,
                  confidence REAL NOT NULL,
                  timestamp TEXT NOT NULL,
                  metadata_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO memory_nodes
                  (id, user_id, persona_id, type, content, importance, confidence, timestamp, created_at, updated_at)
                VALUES ('m-1', 'u-1', 'p-1', 'fact', 'row', 3, 0.3, 't0', 't0', 't0');
                INSERT INTO memory_nodes
                  (id, user_id, persona_id, type, content, importance, confidence, timestamp, created_at, updated_at)
                VALUES ('m-2', '', '', 'fact', 'blank', 3, 0.3, 't0', 't0', 't0');
                "#,
            )
            .expect("seed");

        run_migrations(&connection).expect("migrate");

        let scoped: (String, String) = connection
            .query_row(
                "SELECT user_id, persona_id FROM memory_nodes WHERE id = 'm-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("scoped row");
        assert_eq!(scoped, ("u-1".to_string(), "p-1".to_string()));

        let blank: (String, String) = connection
            .query_row(
                "SELECT user_id, persona_id FROM memory_nodes WHERE id = 'm-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("blank row");
        assert_eq!(
            blank,
            (
                LEGACY_LOCAL_USER_ID.to_string(),
                "persona-default".to_string()
            )
        );
    }

    /// Running the ladder twice is the normal case (the gateway and the
    /// scheduler open the same file), so it must be a no-op the second time.
    #[test]
    fn running_the_migrations_twice_is_a_no_op() {
        let connection = connection();
        run_migrations(&connection).expect("first migrate");
        run_migrations(&connection).expect("second migrate");

        let node_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM memory_nodes", [], |row| row.get(0))
            .expect("count");
        assert_eq!(node_count, 0);
    }

    /// A partially created schema — history table missing, nodes table present
    /// without the scope columns — still converges.
    #[test]
    fn a_partial_schema_converges_to_the_full_one() {
        let connection = connection();
        connection
            .execute_batch(
                r#"
                CREATE TABLE memory_nodes (
                  id TEXT PRIMARY KEY,
                  type TEXT NOT NULL,
                  content TEXT NOT NULL,
                  embedding_json TEXT NOT NULL DEFAULT '[]',
                  importance INTEGER NOT NULL,
                  confidence REAL NOT NULL,
                  timestamp TEXT NOT NULL,
                  metadata_json TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                "#,
            )
            .expect("seed partial");

        run_migrations(&connection).expect("migrate");

        assert!(has_column(&connection, "memory_nodes", "user_id").expect("probe"));
        let history_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'memory_node_history'",
                [],
                |row| row.get(0),
            )
            .expect("check history table");
        assert_eq!(history_exists, 1);
    }
}
