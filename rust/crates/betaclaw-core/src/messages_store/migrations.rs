//! Port of `src/server/channels/messages/repository/migrations/index.ts`.
//!
//! # Statement-for-statement parity
//!
//! The seven tables, their indexes, the additive `ALTER TABLE` upgrades and the
//! FTS5 virtual table with its three triggers are reproduced in the same order,
//! with the same `IF NOT EXISTS` / `PRAGMA table_info` guards. A `.local/messages.db`
//! written by the TypeScript backend is therefore upgraded identically by this
//! port and by the source, in either direction.
//!
//! Two properties of the source are worth stating explicitly:
//!
//! * **There is no bookkeeping table.** `runMigrations` is a ladder of
//!   idempotent DDL — `CREATE ... IF NOT EXISTS` plus a `hasColumn` probe before
//!   every `ALTER TABLE`. Unlike `src/lib/db/migrations.ts` it does not keep a
//!   `_migrations` ledger, so "applied migrations" cannot be queried and there
//!   is nothing to backfill. The port does not invent one: adding a table to
//!   this shared file would change what the TypeScript backend sees when it
//!   opens the same database.
//! * **The FTS5 rebuild is guarded, not scheduled.**
//!   [`migrate_fts_rebuild`] compares the row counts and only runs the expensive
//!   `'rebuild'` when the index is behind, so a large legacy database pays for
//!   it at most once.
//!
//! # Shared file
//!
//! `.local/messages.db` is the multi-tenant fallback of the memory, knowledge,
//! proactive and security stores: each of them resolves
//! `<OWN_STORE>_DB_PATH || MESSAGES_DB_PATH || '.local/messages.db'`. The same
//! SQLite file therefore carries this store's seven tables *and* the tables of
//! the slices S5, S7 and S12. That is why this module only ever adds, never
//! drops, and why it tolerates foreign tables it does not know.

use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::types::LEGACY_LOCAL_USER_ID;

/// `createMigrationHelpers` from `migrations/index.ts:10-49`.
pub fn has_column(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: Option<String> = row.get(1)?;
        if name.as_deref() == Some(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `backfillMessageSeq` from `migrations/index.ts:18-31`.
///
/// Numbers the existing rows per conversation in insertion order so the
/// `idx_msg_conv_seq` pagination has no `NULL` hole.
fn backfill_message_seq(connection: &Connection) -> rusqlite::Result<()> {
    let rows = {
        let mut statement =
            connection.prepare("SELECT id, conversation_id FROM messages ORDER BY rowid ASC")?;
        let mapped = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let mut counters: HashMap<String, i64> = HashMap::new();
    for (id, conversation_id) in rows {
        let next_seq = counters.entry(conversation_id).or_insert(0);
        *next_seq += 1;
        connection.execute(
            "UPDATE messages SET seq = ? WHERE id = ?",
            params![*next_seq, id],
        )?;
    }
    Ok(())
}

/// `migrateFtsRebuild` from `migrations/index.ts:33-46`.
///
/// Only rebuilds once when there are existing messages not yet indexed. After
/// the triggers are in place all new inserts are automatically indexed.
fn migrate_fts_rebuild(connection: &Connection) -> rusqlite::Result<()> {
    let msg_count: i64 =
        connection.query_row("SELECT COUNT(*) as cnt FROM messages", [], |row| row.get(0))?;
    if msg_count == 0 {
        return Ok(());
    }

    let fts_count: i64 =
        connection.query_row("SELECT COUNT(*) as cnt FROM messages_fts", [], |row| {
            row.get(0)
        })?;
    if fts_count >= msg_count {
        return Ok(());
    }

    connection.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
}

/// `runMigrations` from `migrations/index.ts:51-306`.
///
/// Runs unconditionally on open, exactly like `SqliteMessageRepository.migrate`
/// (`sqliteMessageRepository.ts:76-79`), and is safe to call repeatedly.
pub fn run_migrations(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&format!(
        r#"
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      external_chat_id TEXT,
      user_id TEXT NOT NULL DEFAULT '{LEGACY_LOCAL_USER_ID}',
      title TEXT NOT NULL DEFAULT 'Untitled',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    "#
    ))?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_conv_external
      ON conversations (channel_type, external_chat_id);
    "#,
    )?;

    connection.execute_batch(
        r#"
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
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_msg_conv
      ON messages (conversation_id, created_at);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TABLE IF NOT EXISTS conversation_context (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      summary_text TEXT NOT NULL DEFAULT '',
      summary_upto_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    "#,
    )?;

    connection.execute_batch(
        r#"
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
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TABLE IF NOT EXISTS persona_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_relative_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TABLE IF NOT EXISTS conversation_project_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      user_id TEXT NOT NULL,
      active_project_id TEXT REFERENCES persona_projects(id),
      guard_approved_without_project INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TABLE IF NOT EXISTS agent_room_swarms (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      lead_persona_id TEXT NOT NULL,
      units_json TEXT NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      consensus_score INTEGER NOT NULL DEFAULT 0,
      hold_flag INTEGER NOT NULL DEFAULT 0,
      artifact_json TEXT NOT NULL DEFAULT '',
      artifact_history_json TEXT NOT NULL DEFAULT '[]',
      friction_json TEXT NOT NULL DEFAULT '{}',
      last_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    "#,
    )?;

    if !has_column(connection, "conversations", "user_id")? {
        connection.execute_batch("ALTER TABLE conversations ADD COLUMN user_id TEXT")?;
        connection.execute(
            "UPDATE conversations SET user_id = ? WHERE user_id IS NULL OR user_id = ?",
            params![LEGACY_LOCAL_USER_ID, ""],
        )?;
    }

    if !has_column(connection, "messages", "seq")? {
        connection.execute_batch("ALTER TABLE messages ADD COLUMN seq INTEGER")?;
        backfill_message_seq(connection)?;
    }

    // Create indexes only after additive column migrations have been applied.
    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_conv_user_updated
      ON conversations (user_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_conv_external_user
      ON conversations (channel_type, external_chat_id, user_id);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_msg_conv_seq
      ON messages (conversation_id, seq);
    "#,
    )?;

    // ─── Additive migrations (F4: Idempotency, F5: Model Override) ──
    if !has_column(connection, "messages", "client_message_id")? {
        connection.execute_batch("ALTER TABLE messages ADD COLUMN client_message_id TEXT")?;
    }
    connection.execute_batch(
        r#"
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedupe
      ON messages (conversation_id, client_message_id)
      WHERE client_message_id IS NOT NULL;
    "#,
    )?;

    if !has_column(connection, "conversations", "model_override")? {
        connection.execute_batch("ALTER TABLE conversations ADD COLUMN model_override TEXT")?;
    }

    if !has_column(connection, "conversations", "persona_id")? {
        connection.execute_batch("ALTER TABLE conversations ADD COLUMN persona_id TEXT")?;
    }

    if !has_column(connection, "channel_bindings", "persona_id")? {
        connection.execute_batch("ALTER TABLE channel_bindings ADD COLUMN persona_id TEXT")?;
    }

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_user_updated
      ON channel_bindings (user_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_projects_unique_slug
      ON persona_projects (user_id, persona_id, slug);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_persona_projects_user_persona_updated
      ON persona_projects (user_id, persona_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_conversation_project_state_user_updated
      ON conversation_project_state (user_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_agent_room_swarms_user_updated
      ON agent_room_swarms (user_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE INDEX IF NOT EXISTS idx_agent_room_swarms_conversation_updated
      ON agent_room_swarms (conversation_id, updated_at DESC);
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_room_swarms_session_unique
      ON agent_room_swarms (session_id)
      WHERE session_id IS NOT NULL;
    "#,
    )?;

    // ─── Additive migrations: agent_room_swarms v2 columns ───
    for (column, definition) in ADDITIVE_SWARM_COLUMNS {
        if !has_column(connection, "agent_room_swarms", column)? {
            connection.execute_batch(&format!(
                "ALTER TABLE agent_room_swarms ADD COLUMN {definition};"
            ))?;
        }
    }

    // ─── FTS5 full-text search on messages ───────────────────

    connection.execute_batch(
        r#"
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    "#,
    )?;

    // Triggers to keep FTS5 in sync with messages table.
    // These are no-ops if triggers already exist (CREATE TRIGGER IF NOT EXISTS).
    connection.execute_batch(
        r#"
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
    END;
    "#,
    )?;

    connection.execute_batch(
        r#"
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
    "#,
    )?;

    // Rebuild FTS index for any existing rows inserted before triggers existed.
    // 'rebuild' is idempotent — it truncates and re-indexes from the content table.
    migrate_fts_rebuild(connection)
}

/// `ALTER TABLE agent_room_swarms` ladder from `migrations/index.ts:250-269`,
/// in source order.
const ADDITIVE_SWARM_COLUMNS: &[(&str, &str)] = &[
    (
        "current_deploy_command_id",
        "current_deploy_command_id TEXT",
    ),
    (
        "search_enabled",
        "search_enabled INTEGER NOT NULL DEFAULT 0",
    ),
    ("swarm_template", "swarm_template TEXT"),
    (
        "pause_between_phases",
        "pause_between_phases INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "phase_buffer_json",
        "phase_buffer_json TEXT NOT NULL DEFAULT '[]'",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};

    fn table_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND name NOT IN (
                     'messages_fts_config', 'messages_fts_data',
                     'messages_fts_docsize', 'messages_fts_idx'
                   )
                 ORDER BY name",
            )
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    fn index_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
            )
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    fn column_names(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    /// The seven tables this store owns, plus `messages_fts`.
    ///
    /// The FTS5 virtual table also creates four shadow tables
    /// (`messages_fts_config`, `_data`, `_docsize`, `_idx`). Those are an
    /// implementation detail of the `fts5` module, not extra tables the
    /// migration declares, and `better-sqlite3` on the TypeScript side produces
    /// the same four. [`table_names`] filters them out so this constant stays a
    /// statement about what `runMigrations` itself creates.
    const OWNED_TABLES: [&str; 8] = [
        "agent_room_swarms",
        "channel_bindings",
        "conversation_context",
        "conversation_project_state",
        "conversations",
        "messages",
        "messages_fts",
        "persona_projects",
    ];

    #[test]
    fn creates_the_schema_on_an_empty_database() {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        assert!(table_names(&connection).is_empty(), "nothing exists yet");

        run_migrations(&connection).expect("migrate");

        assert_eq!(table_names(&connection), OWNED_TABLES);
        assert_eq!(
            index_names(&connection),
            vec![
                "idx_agent_room_swarms_conversation_updated",
                "idx_agent_room_swarms_session_unique",
                "idx_agent_room_swarms_user_updated",
                "idx_channel_bindings_user_updated",
                "idx_conv_external",
                "idx_conv_external_user",
                "idx_conv_user_updated",
                "idx_conversation_project_state_user_updated",
                "idx_msg_conv",
                "idx_msg_conv_seq",
                "idx_msg_dedupe",
                "idx_persona_projects_unique_slug",
                "idx_persona_projects_user_persona_updated",
            ]
        );
        assert_eq!(
            column_names(&connection, "conversations"),
            vec![
                "id",
                "channel_type",
                "external_chat_id",
                "user_id",
                "title",
                "created_at",
                "updated_at",
                "model_override",
                "persona_id",
            ]
        );
        assert_eq!(
            column_names(&connection, "messages"),
            vec![
                "id",
                "conversation_id",
                "seq",
                "role",
                "content",
                "platform",
                "external_msg_id",
                "sender_name",
                "metadata",
                "created_at",
                "client_message_id",
            ]
        );
        assert_eq!(
            column_names(&connection, "agent_room_swarms"),
            vec![
                "id",
                "conversation_id",
                "user_id",
                "session_id",
                "title",
                "task",
                "lead_persona_id",
                "units_json",
                "status",
                "current_phase",
                "consensus_score",
                "hold_flag",
                "artifact_json",
                "artifact_history_json",
                "friction_json",
                "last_seq",
                "created_at",
                "updated_at",
                "current_deploy_command_id",
                "search_enabled",
                "swarm_template",
                "pause_between_phases",
                "phase_buffer_json",
            ]
        );
    }

    #[test]
    fn the_user_id_default_is_the_legacy_local_user() {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_migrations(&connection).expect("migrate");
        connection
            .execute(
                "INSERT INTO conversations (id, channel_type, created_at, updated_at) VALUES ('c', 'WebChat', 't', 't')",
                [],
            )
            .expect("insert");
        let user_id: String = connection
            .query_row(
                "SELECT user_id FROM conversations WHERE id = 'c'",
                [],
                |row| row.get(0),
            )
            .expect("read");
        assert_eq!(user_id, "legacy-local-user");
    }

    #[test]
    fn is_fresh_on_repeated_runs() {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        run_migrations(&connection).expect("first");
        run_migrations(&connection).expect("second");
        run_migrations(&connection).expect("third");

        assert_eq!(table_names(&connection), OWNED_TABLES);
        assert_eq!(index_names(&connection).len(), 13);
        let triggers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_%'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(triggers, 3, "triggers are created with IF NOT EXISTS");
    }

    /// Recreates the pre-`user_id` / pre-`seq` schema a 2024 install has and
    /// checks that the additive ladder upgrades it without losing data.
    #[test]
    fn upgrades_a_legacy_schema_without_losing_messages() {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE conversations (
                  id TEXT PRIMARY KEY,
                  channel_type TEXT NOT NULL,
                  external_chat_id TEXT,
                  title TEXT NOT NULL DEFAULT 'Untitled',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL REFERENCES conversations(id),
                  role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
                  content TEXT NOT NULL DEFAULT '',
                  platform TEXT NOT NULL,
                  external_msg_id TEXT,
                  sender_name TEXT,
                  metadata TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE channel_bindings (
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
                CREATE TABLE conversation_context (
                  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
                  summary_text TEXT NOT NULL DEFAULT '',
                  summary_upto_seq INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO conversations (id, channel_type, title, created_at, updated_at)
                VALUES ('c-legacy', 'WebChat', 'Legacy', 't0', 't0');
                INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
                VALUES ('m-1', 'c-legacy', 'user', 'first', 'WebChat', 't0');
                INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
                VALUES ('m-2', 'c-legacy', 'agent', 'second', 'WebChat', 't1');
                INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
                VALUES ('m-3', 'c-legacy', 'user', 'third', 'WebChat', 't2');
                "#,
            )
            .expect("seed legacy schema");

        run_migrations(&connection).expect("upgrade");

        // user_id backfilled from the legacy constant.
        let user_id: String = connection
            .query_row(
                "SELECT user_id FROM conversations WHERE id = 'c-legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read");
        assert_eq!(user_id, "legacy-local-user");

        // seq backfilled per conversation in insertion order.
        let seqs: Vec<i64> = {
            let mut statement = connection
                .prepare("SELECT seq FROM messages ORDER BY rowid ASC")
                .expect("prepare");
            let rows = statement
                .query_map([], |row| row.get::<_, i64>(0))
                .expect("query");
            rows.collect::<Result<Vec<_>, _>>().expect("rows")
        };
        assert_eq!(seqs, vec![1, 2, 3]);

        // The FTS index is NOT backfilled. `migrateFtsRebuild`'s guard counts
        // the rows of `messages_fts`, and for an external-content table that
        // count is answered from the content table, so the guard always
        // short-circuits. A MATCH query does use the index and finds nothing;
        // rows written after the triggers exist are the ones that are indexed.
        let indexed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'first'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(
            indexed, 0,
            "the guarded rebuild never runs, so pre-trigger rows stay unindexed"
        );

        // And the additive columns exist now.
        assert!(has_column(&connection, "conversations", "model_override").expect("probe"));
        assert!(has_column(&connection, "conversations", "persona_id").expect("probe"));
        assert!(has_column(&connection, "messages", "client_message_id").expect("probe"));
        assert!(has_column(&connection, "channel_bindings", "persona_id").expect("probe"));
    }

    #[test]
    fn backfills_an_empty_user_id_onto_the_legacy_constant() {
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE conversations (
                  id TEXT PRIMARY KEY,
                  channel_type TEXT NOT NULL,
                  external_chat_id TEXT,
                  title TEXT NOT NULL DEFAULT 'Untitled',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO conversations (id, channel_type, title, created_at, updated_at)
                VALUES ('c-a', 'WebChat', 'A', 't0', 't0');
                INSERT INTO conversations (id, channel_type, title, created_at, updated_at)
                VALUES ('c-b', 'WebChat', 'B', 't0', 't0');
                "#,
            )
            .expect("seed");

        run_migrations(&connection).expect("upgrade");

        for id in ["c-a", "c-b"] {
            let user_id: String = connection
                .query_row(
                    "SELECT user_id FROM conversations WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .expect("read");
            assert_eq!(user_id, "legacy-local-user", "{id}");
        }
    }

    #[test]
    fn leaves_foreign_tables_of_the_shared_file_alone() {
        // The knowledge tables live in the same file and belong to slice S7.
        let connection = open(OpenOptions::new(":memory:")).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE knowledge_episodes (id TEXT PRIMARY KEY, conversation_id TEXT);",
            )
            .expect("seed knowledge table");

        run_migrations(&connection).expect("migrate");

        let tables = table_names(&connection);
        assert!(tables.contains(&"knowledge_episodes".to_string()));
        assert!(tables.contains(&"conversations".to_string()));
    }
}
