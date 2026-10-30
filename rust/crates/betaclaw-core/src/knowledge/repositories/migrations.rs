//! Port of `src/server/knowledge/repositories/migrations.ts`.
//!
//! # Statement-for-statement parity
//!
//! The nine knowledge tables, their twelve indexes and the three additive
//! `ALTER TABLE` upgrades are reproduced in the same order, with the same
//! `IF NOT EXISTS` / `PRAGMA table_info` guards and the same `COLLATE NOCASE`
//! expressions. A `.local/messages.db` written by the TypeScript backend is
//! therefore upgraded identically by this port and by the source, in either
//! direction.
//!
//! Two properties of the source are worth stating explicitly:
//!
//! * **There is no bookkeeping table.** `runKnowledgeMigrations` is a ladder of
//!   idempotent DDL — `CREATE ... IF NOT EXISTS` plus a `hasColumn` probe before
//!   every `ALTER TABLE`/rename. The port does not invent a ledger: adding a
//!   table to this shared file would change what the TypeScript backend sees.
//! * **The checkpoint rename is a one-way upgrade.**
//!   `knowledge_ingestion_checkpoints` gained the `user_id` column between
//!   releases; a table that has `conversation_id` but no `user_id` is renamed to
//!   `..._legacy`, the new table is created, and the legacy rows are copied with
//!   `LEGACY_LOCAL_USER_ID` before the legacy table is dropped. The copy keeps
//!   `INSERT OR IGNORE`, so a duplicate primary key is skipped, not fatal.
//!
//! # Shared file
//!
//! Like the messages, memory, proactive and security stores, this ladder lives
//! in `.local/messages.db` and only ever adds. It never drops or repurposes a
//! column of a foreign table.

use rusqlite::Connection;

use crate::messages_store::LEGACY_MESSAGES_USER_ID as LEGACY_LOCAL_USER_ID;

/// `hasColumn` from `migrations.ts:4-7`.
///
/// A local copy, exactly like the TypeScript file keeps its own helper: the
/// probe reads `PRAGMA table_info(<table>)` and compares the `name` column.
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

/// `runKnowledgeMigrations` from `migrations.ts:9-279`.
pub fn run_knowledge_migrations(connection: &Connection) -> rusqlite::Result<()> {
    // ── Checkpoints ─────────────────────────────────────────────────────────
    if has_column(
        connection,
        "knowledge_ingestion_checkpoints",
        "conversation_id",
    )? && !has_column(connection, "knowledge_ingestion_checkpoints", "user_id")?
    {
        connection.execute_batch(
            "ALTER TABLE knowledge_ingestion_checkpoints RENAME TO knowledge_ingestion_checkpoints_legacy",
        )?;
    }
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_ingestion_checkpoints (
          conversation_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          last_seq INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, user_id, persona_id)
        );
      ",
    )?;
    if has_column(
        connection,
        "knowledge_ingestion_checkpoints_legacy",
        "conversation_id",
    )? {
        connection.execute_batch(&format!(
            "
            INSERT OR IGNORE INTO knowledge_ingestion_checkpoints
              (conversation_id, user_id, persona_id, last_seq, updated_at)
            SELECT conversation_id, '{LEGACY_LOCAL_USER_ID}', persona_id, last_seq, updated_at
            FROM knowledge_ingestion_checkpoints_legacy;
            DROP TABLE knowledge_ingestion_checkpoints_legacy;
          "
        ))?;
    }

    // ── Episodes ────────────────────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_episodes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          topic_key TEXT NOT NULL,
          counterpart TEXT,
          teaser TEXT NOT NULL,
          episode TEXT NOT NULL,
          facts_json TEXT NOT NULL,
          source_seq_start INTEGER NOT NULL,
          source_seq_end INTEGER NOT NULL,
          source_refs_json TEXT NOT NULL,
          event_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(conversation_id, persona_id, source_seq_start, source_seq_end)
        );
      ",
    )?;
    if has_column(connection, "knowledge_episodes", "id")?
        && !has_column(connection, "knowledge_episodes", "memory_ids_json")?
    {
        connection.execute_batch(
            "ALTER TABLE knowledge_episodes ADD COLUMN memory_ids_json TEXT NOT NULL DEFAULT '[]'",
        )?;
    }

    // ── Meeting Ledger ──────────────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_meeting_ledger (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          topic_key TEXT NOT NULL,
          counterpart TEXT,
          event_at TEXT,
          participants_json TEXT NOT NULL,
          decisions_json TEXT NOT NULL,
          negotiated_terms_json TEXT NOT NULL,
          open_points_json TEXT NOT NULL,
          action_items_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(conversation_id, persona_id, topic_key, event_at)
        );
      ",
    )?;
    if has_column(connection, "knowledge_meeting_ledger", "id")?
        && !has_column(connection, "knowledge_meeting_ledger", "memory_ids_json")?
    {
        connection.execute_batch(
            "ALTER TABLE knowledge_meeting_ledger ADD COLUMN memory_ids_json TEXT NOT NULL DEFAULT '[]'",
        )?;
    }

    // ── Retrieval Audit ─────────────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_retrieval_audit (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          query_text TEXT NOT NULL,
          stage_stats_json TEXT NOT NULL,
          token_count INTEGER NOT NULL,
          had_error INTEGER NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL
        );
      ",
    )?;

    // ── Events ──────────────────────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_events (
          id                  TEXT PRIMARY KEY,
          user_id             TEXT NOT NULL,
          persona_id          TEXT NOT NULL,
          conversation_id     TEXT NOT NULL,
          event_type          TEXT NOT NULL,
          speaker_role        TEXT NOT NULL CHECK(speaker_role IN ('assistant', 'user')),
          speaker_entity      TEXT NOT NULL,
          subject_entity      TEXT NOT NULL,
          counterpart_entity  TEXT NOT NULL,
          relation_label      TEXT,
          start_date          TEXT NOT NULL,
          end_date            TEXT NOT NULL,
          day_count           INTEGER NOT NULL,
          source_seq_json     TEXT NOT NULL DEFAULT '[]',
          source_summary      TEXT NOT NULL DEFAULT '',
          is_confirmation     INTEGER NOT NULL DEFAULT 0,
          confidence          REAL NOT NULL DEFAULT 0.8,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          UNIQUE(user_id, persona_id, event_type, subject_entity, counterpart_entity, start_date, end_date)
        );
      ",
    )?;

    // ── Entity Graph ────────────────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_entities (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL,
          persona_id      TEXT NOT NULL,
          canonical_name  TEXT NOT NULL,
          category        TEXT NOT NULL CHECK(category IN ('person','project','place','organization','concept','object')),
          owner           TEXT NOT NULL CHECK(owner IN ('persona','user','shared')),
          properties_json TEXT NOT NULL DEFAULT '{}',
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          UNIQUE(user_id, persona_id, canonical_name, owner)
        );
      ",
    )?;

    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_entity_aliases (
          id          TEXT PRIMARY KEY,
          entity_id   TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
          alias       TEXT NOT NULL,
          alias_type  TEXT NOT NULL CHECK(alias_type IN ('name','relation','pronoun','abbreviation')),
          owner       TEXT NOT NULL CHECK(owner IN ('persona','user','shared')),
          confidence  REAL NOT NULL DEFAULT 0.8,
          created_at  TEXT NOT NULL,
          UNIQUE(entity_id, alias, owner)
        );
      ",
    )?;

    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_entity_relations (
          id                TEXT PRIMARY KEY,
          source_entity_id  TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
          target_entity_id  TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
          relation_type     TEXT NOT NULL,
          properties_json   TEXT NOT NULL DEFAULT '{}',
          confidence        REAL NOT NULL DEFAULT 0.8,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          UNIQUE(source_entity_id, target_entity_id, relation_type)
        );
      ",
    )?;

    // ── Conversation Summaries ──────────────────────────────────────────────
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS knowledge_conversation_summaries (
          id                  TEXT PRIMARY KEY,
          user_id             TEXT NOT NULL,
          persona_id          TEXT NOT NULL,
          conversation_id     TEXT NOT NULL,
          summary_text        TEXT NOT NULL,
          key_topics_json     TEXT NOT NULL DEFAULT '[]',
          entities_json       TEXT NOT NULL DEFAULT '[]',
          emotional_tone      TEXT,
          message_count       INTEGER NOT NULL DEFAULT 0,
          time_range_start    TEXT NOT NULL,
          time_range_end      TEXT NOT NULL,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          UNIQUE(conversation_id, persona_id)
        );
      ",
    )?;

    // ── Indexes ─────────────────────────────────────────────────────────────
    for statement in [
        "CREATE INDEX IF NOT EXISTS idx_knowledge_episodes_user_persona_updated
          ON knowledge_episodes (user_id, persona_id, updated_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_counterpart_event
          ON knowledge_meeting_ledger (user_id, persona_id, counterpart, event_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_topic_event
          ON knowledge_meeting_ledger (user_id, persona_id, topic_key, event_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_audit_user_persona_created
          ON knowledge_retrieval_audit (user_id, persona_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_audit_conversation_id
          ON knowledge_retrieval_audit (conversation_id);",
        "CREATE INDEX IF NOT EXISTS idx_events_scope
          ON knowledge_events(user_id, persona_id, event_type, speaker_role);",
        "CREATE INDEX IF NOT EXISTS idx_events_counterpart
          ON knowledge_events(user_id, persona_id, counterpart_entity);",
        "CREATE INDEX IF NOT EXISTS idx_events_dates
          ON knowledge_events(user_id, persona_id, start_date, end_date);",
        "CREATE INDEX IF NOT EXISTS idx_entity_scope
          ON knowledge_entities(user_id, persona_id, category);",
        "CREATE INDEX IF NOT EXISTS idx_entity_name
          ON knowledge_entities(user_id, persona_id, canonical_name COLLATE NOCASE);",
        "CREATE INDEX IF NOT EXISTS idx_alias_lookup
          ON knowledge_entity_aliases(alias COLLATE NOCASE, owner);",
        "CREATE INDEX IF NOT EXISTS idx_alias_entity
          ON knowledge_entity_aliases(entity_id);",
        "CREATE INDEX IF NOT EXISTS idx_relation_source
          ON knowledge_entity_relations(source_entity_id);",
        "CREATE INDEX IF NOT EXISTS idx_relation_target
          ON knowledge_entity_relations(target_entity_id);",
        "CREATE INDEX IF NOT EXISTS idx_summaries_scope
          ON knowledge_conversation_summaries(user_id, persona_id, updated_at DESC);",
    ] {
        connection.execute_batch(statement)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};

    fn connection() -> Connection {
        open(OpenOptions::new(":memory:")).expect("open in-memory database")
    }

    fn table_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("rows")
    }

    /// The nine knowledge tables and every index are created; a second run is a
    /// no-op, because the gateway and the scheduler open the same file.
    #[test]
    fn running_the_ladder_twice_is_a_no_op() {
        let connection = connection();
        run_knowledge_migrations(&connection).expect("first migrate");
        run_knowledge_migrations(&connection).expect("second migrate");

        let tables = table_names(&connection);
        for expected in [
            "knowledge_ingestion_checkpoints",
            "knowledge_episodes",
            "knowledge_meeting_ledger",
            "knowledge_retrieval_audit",
            "knowledge_events",
            "knowledge_entities",
            "knowledge_entity_aliases",
            "knowledge_entity_relations",
            "knowledge_conversation_summaries",
        ] {
            assert!(tables.contains(&expected.to_string()), "missing {expected}");
        }

        let indexes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                 AND name LIKE 'idx_%' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .expect("count indexes");
        assert_eq!(indexes, 15, "the fifteen CREATE INDEX statements");
    }

    /// A pre-`user_id` checkpoint table is renamed, rebuilt and backfilled onto
    /// the legacy local user, then the legacy table is dropped.
    #[test]
    fn the_legacy_checkpoint_table_is_upgraded_and_dropped() {
        let connection = connection();
        connection
            .execute_batch(
                "
                CREATE TABLE knowledge_ingestion_checkpoints (
                  conversation_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  last_seq INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (conversation_id, persona_id)
                );
                INSERT INTO knowledge_ingestion_checkpoints
                  (conversation_id, persona_id, last_seq, updated_at)
                VALUES ('c-1', 'p-1', 7, 't0');
                ",
            )
            .expect("seed legacy");

        run_knowledge_migrations(&connection).expect("upgrade");

        let row: (String, String, i64) = connection
            .query_row(
                "SELECT user_id, persona_id, last_seq FROM knowledge_ingestion_checkpoints
                 WHERE conversation_id = 'c-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("upgraded row");
        assert_eq!(
            row,
            (LEGACY_LOCAL_USER_ID.to_string(), "p-1".to_string(), 7)
        );

        let tables = table_names(&connection);
        assert!(
            !tables.contains(&"knowledge_ingestion_checkpoints_legacy".to_string()),
            "the legacy table is dropped"
        );
        assert!(
            has_column(&connection, "knowledge_ingestion_checkpoints", "user_id").expect("probe")
        );
    }

    /// The two `memory_ids_json` upgrades only run on a table that lacks them.
    #[test]
    fn the_memory_ids_columns_are_added_once() {
        let connection = connection();
        connection
            .execute_batch(
                "
                CREATE TABLE knowledge_episodes (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  persona_id TEXT NOT NULL,
                  conversation_id TEXT NOT NULL,
                  topic_key TEXT NOT NULL,
                  teaser TEXT NOT NULL,
                  episode TEXT NOT NULL,
                  facts_json TEXT NOT NULL,
                  source_seq_start INTEGER NOT NULL,
                  source_seq_end INTEGER NOT NULL,
                  source_refs_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                ",
            )
            .expect("seed episodes");

        run_knowledge_migrations(&connection).expect("upgrade");
        assert!(has_column(&connection, "knowledge_episodes", "memory_ids_json").expect("probe"));
        assert!(
            has_column(&connection, "knowledge_meeting_ledger", "memory_ids_json").expect("probe")
        );
    }

    /// Foreign tables of the shared `.local/messages.db` survive untouched.
    #[test]
    fn foreign_tables_survive() {
        let connection = connection();
        connection
            .execute_batch("CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);")
            .expect("seed foreign");

        run_knowledge_migrations(&connection).expect("migrate");

        let tables = table_names(&connection);
        assert!(tables.contains(&"conversations".to_string()));
        assert!(tables.contains(&"knowledge_episodes".to_string()));
    }
}
