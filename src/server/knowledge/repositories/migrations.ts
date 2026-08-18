import type BetterSqlite3 from 'better-sqlite3';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';

function hasColumn(db: BetterSqlite3.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function runKnowledgeMigrations(db: BetterSqlite3.Database): void {
  // Checkpoints
  if (
    hasColumn(db, 'knowledge_ingestion_checkpoints', 'conversation_id') &&
    !hasColumn(db, 'knowledge_ingestion_checkpoints', 'user_id')
  ) {
    db.exec(
      'ALTER TABLE knowledge_ingestion_checkpoints RENAME TO knowledge_ingestion_checkpoints_legacy',
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_ingestion_checkpoints (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id, persona_id)
    );
  `);
  if (hasColumn(db, 'knowledge_ingestion_checkpoints_legacy', 'conversation_id')) {
    db.exec(`
      INSERT OR IGNORE INTO knowledge_ingestion_checkpoints
        (conversation_id, user_id, persona_id, last_seq, updated_at)
      SELECT conversation_id, '${LEGACY_LOCAL_USER_ID}', persona_id, last_seq, updated_at
      FROM knowledge_ingestion_checkpoints_legacy;
      DROP TABLE knowledge_ingestion_checkpoints_legacy;
    `);
  }

  // Episodes
  db.exec(`
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
  `);
  if (
    hasColumn(db, 'knowledge_episodes', 'id') &&
    !hasColumn(db, 'knowledge_episodes', 'memory_ids_json')
  ) {
    db.exec("ALTER TABLE knowledge_episodes ADD COLUMN memory_ids_json TEXT NOT NULL DEFAULT '[]'");
  }

  // Meeting Ledger
  db.exec(`
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
  `);
  if (
    hasColumn(db, 'knowledge_meeting_ledger', 'id') &&
    !hasColumn(db, 'knowledge_meeting_ledger', 'memory_ids_json')
  ) {
    db.exec(
      "ALTER TABLE knowledge_meeting_ledger ADD COLUMN memory_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
  }

  // Retrieval Audit
  db.exec(`
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
  `);

  // Events
  db.exec(`
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
  `);

  // Entity Graph
  db.exec(`
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
  `);

  db.exec(`
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
  `);

  db.exec(`
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
  `);

  // Conversation Summaries
  db.exec(`
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
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_episodes_user_persona_updated
      ON knowledge_episodes (user_id, persona_id, updated_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_counterpart_event
      ON knowledge_meeting_ledger (user_id, persona_id, counterpart, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_topic_event
      ON knowledge_meeting_ledger (user_id, persona_id, topic_key, event_at DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_audit_user_persona_created
      ON knowledge_retrieval_audit (user_id, persona_id, created_at DESC);
  `);

  // conversation_id index for efficient deleteConversation / cascade cleanup
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_audit_conversation_id
      ON knowledge_retrieval_audit (conversation_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_scope
      ON knowledge_events(user_id, persona_id, event_type, speaker_role);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_counterpart
      ON knowledge_events(user_id, persona_id, counterpart_entity);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_dates
      ON knowledge_events(user_id, persona_id, start_date, end_date);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entity_scope
      ON knowledge_entities(user_id, persona_id, category);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entity_name
      ON knowledge_entities(user_id, persona_id, canonical_name COLLATE NOCASE);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alias_lookup
      ON knowledge_entity_aliases(alias COLLATE NOCASE, owner);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alias_entity
      ON knowledge_entity_aliases(entity_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relation_source
      ON knowledge_entity_relations(source_entity_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relation_target
      ON knowledge_entity_relations(target_entity_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_summaries_scope
      ON knowledge_conversation_summaries(user_id, persona_id, updated_at DESC);
  `);
}
