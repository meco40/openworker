import type BetterSqlite3 from 'better-sqlite3';

function ensureColumnExists(
  db: ReturnType<typeof BetterSqlite3>,
  table: string,
  column: string,
  type: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  const hasColumn = rows.some((row) => String(row.name) === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function migratePromptDispatchRepository(db: ReturnType<typeof BetterSqlite3>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_dispatch_logs (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      account_id TEXT,
      dispatch_kind TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_tokens_source TEXT NOT NULL,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      risk_level TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      risk_reasons_json TEXT NOT NULL DEFAULT '[]',
      prompt_preview TEXT NOT NULL,
      prompt_payload_json TEXT NOT NULL,
      prompt_cost_usd REAL,
      completion_cost_usd REAL,
      total_cost_usd REAL,
      created_at TEXT NOT NULL
    );
  `);

  ensureColumnExists(db, 'prompt_dispatch_logs', 'prompt_cost_usd', 'REAL');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'completion_cost_usd', 'REAL');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'total_cost_usd', 'REAL');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'conversation_id', 'TEXT');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'turn_seq', 'INTEGER');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'latency_ms', 'INTEGER');
  ensureColumnExists(db, 'prompt_dispatch_logs', 'tool_calls_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumnExists(db, 'prompt_dispatch_logs', 'memory_context_json', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_conversation
      ON prompt_dispatch_logs (conversation_id)
      WHERE conversation_id IS NOT NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_created
      ON prompt_dispatch_logs (created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_provider
      ON prompt_dispatch_logs (provider_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_model
      ON prompt_dispatch_logs (model_name);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_risk
      ON prompt_dispatch_logs (risk_level);
  `);
}
