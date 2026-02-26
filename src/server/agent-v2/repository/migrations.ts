import type BetterSqlite3 from 'better-sqlite3';

export function runMigrations(db: BetterSqlite3.Database): void {
  db.exec(`
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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_v2_sessions_user_updated
    ON agent_v2_sessions (user_id, updated_at DESC);
  `);

  db.exec(`
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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_v2_commands_session_status_priority
    ON agent_v2_commands (session_id, status, priority DESC, enqueued_at ASC);
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_commands_idempotency
    ON agent_v2_commands (session_id, command_type, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_v2_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_v2_sessions(id) ON DELETE CASCADE,
      command_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      emitted_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_events_session_seq
    ON agent_v2_events (session_id, seq);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_v2_events_session_emitted
    ON agent_v2_events (session_id, emitted_at ASC);
  `);

  db.exec(`
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
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_v2_signing_keys (
      key_id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      rotated_at TEXT,
      revoked_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_v2_revoked_signatures (
      signature_digest TEXT PRIMARY KEY,
      reason TEXT,
      revoked_at TEXT NOT NULL
    );
  `);
}
