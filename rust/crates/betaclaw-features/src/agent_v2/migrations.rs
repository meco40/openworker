//! Port of `src/server/agent-v2/repository/migrations.ts`.
//!
//! Same statements, same order, same `IF NOT EXISTS` guards, so a database written
//! by either side opens unchanged on the other. There is no `_migrations` ledger:
//! the TypeScript file has none, and adding a table to the shared messages file
//! would change what the TypeScript backend sees.

use rusqlite::Connection;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS agent_v2_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      last_seq INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_v2_sessions_user_updated
    ON agent_v2_sessions (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_v2_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_v2_sessions(id) ON DELETE CASCADE,
      command_type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT,
      result_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_v2_commands_session_status_priority
    ON agent_v2_commands (session_id, status, priority DESC, enqueued_at ASC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_commands_idempotency
    ON agent_v2_commands (session_id, command_type, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS agent_v2_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_v2_sessions(id) ON DELETE CASCADE,
      command_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      emitted_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_events_session_seq
    ON agent_v2_events (session_id, seq);

    CREATE INDEX IF NOT EXISTS idx_agent_v2_events_session_emitted
    ON agent_v2_events (session_id, emitted_at ASC);

    CREATE TABLE IF NOT EXISTS agent_v2_extensions (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version, digest)
    );

    CREATE TABLE IF NOT EXISTS agent_v2_signing_keys (
      key_id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_v2_revoked_signatures (
      signature_digest TEXT PRIMARY KEY,
      reason TEXT,
      revoked_at TEXT NOT NULL
    );
";

/// `runMigrations`. Idempotent: every statement is guarded.
pub fn run_migrations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    #[test]
    fn creates_the_six_tables_and_is_repeatable() {
        let connection = Connection::open_in_memory().expect("open");
        run_migrations(&connection).expect("first run");
        run_migrations(&connection).expect("second run");

        assert_eq!(
            table_names(&connection),
            vec![
                "agent_v2_commands",
                "agent_v2_events",
                "agent_v2_extensions",
                "agent_v2_revoked_signatures",
                "agent_v2_sessions",
                "agent_v2_signing_keys",
            ]
        );
    }
}
