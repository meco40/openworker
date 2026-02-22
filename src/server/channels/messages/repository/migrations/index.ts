import type BetterSqlite3 from 'better-sqlite3';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

export interface MigrationHelpers {
  hasColumn: (tableName: string, columnName: string) => boolean;
  backfillMessageSeq: () => void;
  migrateFtsRebuild: () => void;
}

export function createMigrationHelpers(db: BetterSqlite3.Database): MigrationHelpers {
  function hasColumn(tableName: string, columnName: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === columnName);
  }

  function backfillMessageSeq(): void {
    const rows = db
      .prepare('SELECT id, conversation_id FROM messages ORDER BY rowid ASC')
      .all() as Array<{ id: string; conversation_id: string }>;

    const counters = new Map<string, number>();
    const updateStmt = db.prepare('UPDATE messages SET seq = ? WHERE id = ?');

    for (const row of rows) {
      const nextSeq = (counters.get(row.conversation_id) || 0) + 1;
      counters.set(row.conversation_id, nextSeq);
      updateStmt.run(nextSeq, row.id);
    }
  }

  function migrateFtsRebuild(): void {
    // Only rebuild once when there are existing messages not yet indexed.
    // After triggers are in place all new inserts are automatically indexed.
    const msgCount = (db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number })
      .cnt;
    if (msgCount === 0) return;

    const ftsCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number }
    ).cnt;
    if (ftsCount >= msgCount) return;

    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  }

  return { hasColumn, backfillMessageSeq, migrateFtsRebuild };
}

export function runMigrations(db: BetterSqlite3.Database, helpers: MigrationHelpers): void {
  const { hasColumn, backfillMessageSeq, migrateFtsRebuild } = helpers;

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      external_chat_id TEXT,
      user_id TEXT NOT NULL DEFAULT '${LEGACY_LOCAL_USER_ID}',
      title TEXT NOT NULL DEFAULT 'Untitled',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_external
      ON conversations (channel_type, external_chat_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
      content TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL,
      external_msg_id TEXT,
      sender_name TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_msg_conv
      ON messages (conversation_id, created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_context (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      summary_text TEXT NOT NULL DEFAULT '',
      summary_upto_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_bindings (
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      external_peer_id TEXT,
      peer_name TEXT,
      transport TEXT,
      metadata TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, channel)
    );
  `);

  if (!hasColumn('conversations', 'user_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN user_id TEXT`);
    db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL OR user_id = ?').run(
      LEGACY_LOCAL_USER_ID,
      '',
    );
  }

  if (!hasColumn('messages', 'seq')) {
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
    backfillMessageSeq();
  }

  // Create indexes only after additive column migrations have been applied.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_user_updated
      ON conversations (user_id, updated_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_external_user
      ON conversations (channel_type, external_chat_id, user_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_msg_conv_seq
      ON messages (conversation_id, seq);
  `);

  // ─── Additive migrations (F4: Idempotency, F5: Model Override) ──
  if (!hasColumn('messages', 'client_message_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN client_message_id TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedupe
      ON messages (conversation_id, client_message_id)
      WHERE client_message_id IS NOT NULL;
  `);

  if (!hasColumn('conversations', 'model_override')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN model_override TEXT`);
  }

  if (!hasColumn('conversations', 'persona_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN persona_id TEXT`);
  }

  if (!hasColumn('channel_bindings', 'persona_id')) {
    db.exec(`ALTER TABLE channel_bindings ADD COLUMN persona_id TEXT`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_user_updated
      ON channel_bindings (user_id, updated_at DESC);
  `);

  // ─── FTS5 full-text search on messages ───────────────────

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  // Triggers to keep FTS5 in sync with messages table.
  // These are no-ops if triggers already exist (CREATE TRIGGER IF NOT EXISTS).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
  `);

  // Rebuild FTS index for any existing rows inserted before triggers existed.
  // 'rebuild' is idempotent — it truncates and re-indexes from the content table.
  migrateFtsRebuild();
}
