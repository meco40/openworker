import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type {
  KnowledgeEpisode,
  KnowledgeEpisodeInput,
  KnowledgeEpisodeUpdateInput,
  KnowledgeIngestionCheckpoint,
  KnowledgeIngestionCheckpointInput,
  KnowledgeMeetingLedgerEntry,
  KnowledgeMeetingLedgerEntryInput,
  KnowledgeMeetingLedgerEntryUpdateInput,
  KnowledgeRepository,
  KnowledgeRetrievalAudit,
  KnowledgeRetrievalAuditInput,
  KnowledgeRetrievalAuditUpdateInput,
} from './repository';

interface IngestionCheckpointRow {
  user_id: string;
  persona_id: string;
  conversation_id: string;
  last_processed_seq: number;
  created_at: string;
  updated_at: string;
}

interface EpisodeRow {
  id: string;
  user_id: string;
  persona_id: string;
  topic_key: string;
  counterpart: string;
  date: string;
  teaser: string;
  summary: string;
  source_refs_json: string;
  created_at: string;
  updated_at: string;
}

interface MeetingLedgerRow {
  id: string;
  user_id: string;
  persona_id: string;
  counterpart: string;
  topic_key: string;
  date: string;
  decisions_json: string;
  negotiated_terms_json: string;
  open_points_json: string;
  action_items_json: string;
  source_refs_json: string;
  created_at: string;
  updated_at: string;
}

interface RetrievalAuditRow {
  id: string;
  user_id: string;
  persona_id: string;
  query_text: string;
  counterpart: string | null;
  topic_key: string | null;
  date: string | null;
  result_ids_json: string;
  created_at: string;
  updated_at: string;
}

function normalizeArray(values: string[]): string[] {
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value));
  } catch {
    return [];
  }
}

function toCheckpoint(row: IngestionCheckpointRow): KnowledgeIngestionCheckpoint {
  return {
    userId: row.user_id,
    personaId: row.persona_id,
    conversationId: row.conversation_id,
    lastProcessedSeq: Number(row.last_processed_seq || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEpisode(row: EpisodeRow): KnowledgeEpisode {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    topicKey: row.topic_key,
    counterpart: row.counterpart,
    date: row.date,
    teaser: row.teaser,
    summary: row.summary,
    sourceRefs: parseStringArray(row.source_refs_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMeetingLedgerEntry(row: MeetingLedgerRow): KnowledgeMeetingLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    counterpart: row.counterpart,
    topicKey: row.topic_key,
    date: row.date,
    decisions: parseStringArray(row.decisions_json),
    negotiatedTerms: parseStringArray(row.negotiated_terms_json),
    openPoints: parseStringArray(row.open_points_json),
    actionItems: parseStringArray(row.action_items_json),
    sourceRefs: parseStringArray(row.source_refs_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRetrievalAudit(row: RetrievalAuditRow): KnowledgeRetrievalAudit {
  return {
    id: row.id,
    userId: row.user_id,
    personaId: row.persona_id,
    queryText: row.query_text,
    counterpart: row.counterpart,
    topicKey: row.topic_key,
    date: row.date,
    resultIds: parseStringArray(row.result_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;
  private closed = false;

  constructor(
    dbPath =
      process.env.KNOWLEDGE_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/knowledge.db',
  ) {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_ingestion_checkpoints (
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_processed_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, persona_id, conversation_id)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_episodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        counterpart TEXT NOT NULL,
        date TEXT NOT NULL,
        teaser TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_meeting_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        counterpart TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        date TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        negotiated_terms_json TEXT NOT NULL,
        open_points_json TEXT NOT NULL,
        action_items_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_retrieval_audit (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        counterpart TEXT,
        topic_key TEXT,
        date TEXT,
        result_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_checkpoints_scope_updated
      ON knowledge_ingestion_checkpoints (user_id, persona_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_episodes_scope_updated
      ON knowledge_episodes (user_id, persona_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_episodes_topic_date
      ON knowledge_episodes (topic_key, date DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_meeting_scope_updated
      ON knowledge_meeting_ledger (user_id, persona_id, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_meeting_counterpart_date
      ON knowledge_meeting_ledger (counterpart, date DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_meeting_topic_date
      ON knowledge_meeting_ledger (topic_key, date DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_retrieval_audit_scope_updated
      ON knowledge_retrieval_audit (user_id, persona_id, updated_at DESC);
    `);
  }

  upsertIngestionCheckpoint(
    input: KnowledgeIngestionCheckpointInput,
  ): KnowledgeIngestionCheckpoint {
    const updatedAt = input.updatedAt || new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_ingestion_checkpoints (
          user_id, persona_id, conversation_id, last_processed_seq, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, persona_id, conversation_id) DO UPDATE SET
          last_processed_seq = excluded.last_processed_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.userId,
        input.personaId,
        input.conversationId,
        input.lastProcessedSeq,
        updatedAt,
        updatedAt,
      );

    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_ingestion_checkpoints
        WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      `,
      )
      .get(input.userId, input.personaId, input.conversationId) as IngestionCheckpointRow | undefined;
    if (!row) {
      throw new Error('Failed to upsert knowledge ingestion checkpoint.');
    }
    return toCheckpoint(row);
  }

  getIngestionCheckpoint(
    userId: string,
    personaId: string,
    conversationId: string,
  ): KnowledgeIngestionCheckpoint | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_ingestion_checkpoints
        WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      `,
      )
      .get(userId, personaId, conversationId) as IngestionCheckpointRow | undefined;
    return row ? toCheckpoint(row) : null;
  }

  deleteIngestionCheckpoint(userId: string, personaId: string, conversationId: string): number {
    const result = this.db
      .prepare(
        `
        DELETE FROM knowledge_ingestion_checkpoints
        WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      `,
      )
      .run(userId, personaId, conversationId);
    return Number(result.changes || 0);
  }

  insertEpisode(input: KnowledgeEpisodeInput): KnowledgeEpisode {
    const now = input.updatedAt || new Date().toISOString();
    const sourceRefs = normalizeArray(input.sourceRefs);
    this.db
      .prepare(
        `
        INSERT INTO knowledge_episodes (
          id, user_id, persona_id, topic_key, counterpart, date, teaser, summary, source_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.topicKey,
        input.counterpart,
        input.date,
        input.teaser,
        input.summary,
        JSON.stringify(sourceRefs),
        now,
        now,
      );

    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_episodes
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .get(input.id, input.userId, input.personaId) as EpisodeRow | undefined;
    if (!row) {
      throw new Error('Failed to insert knowledge episode.');
    }
    return toEpisode(row);
  }

  getEpisode(userId: string, personaId: string, id: string): KnowledgeEpisode | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_episodes
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .get(userId, personaId, id) as EpisodeRow | undefined;
    return row ? toEpisode(row) : null;
  }

  listEpisodes(userId: string, personaId: string, limit = 100): KnowledgeEpisode[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM knowledge_episodes
        WHERE user_id = ? AND persona_id = ?
        ORDER BY date DESC, updated_at DESC
        LIMIT ?
      `,
      )
      .all(userId, personaId, safeLimit) as EpisodeRow[];
    return rows.map(toEpisode);
  }

  updateEpisode(input: KnowledgeEpisodeUpdateInput): number {
    const updatedAt = input.updatedAt || new Date().toISOString();
    const sourceRefs = normalizeArray(input.sourceRefs);
    const result = this.db
      .prepare(
        `
        UPDATE knowledge_episodes
        SET topic_key = ?, counterpart = ?, date = ?, teaser = ?, summary = ?, source_refs_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .run(
        input.topicKey,
        input.counterpart,
        input.date,
        input.teaser,
        input.summary,
        JSON.stringify(sourceRefs),
        updatedAt,
        input.id,
        input.userId,
        input.personaId,
      );
    return Number(result.changes || 0);
  }

  deleteEpisode(userId: string, personaId: string, id: string): number {
    const result = this.db
      .prepare(
        `
        DELETE FROM knowledge_episodes
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .run(userId, personaId, id);
    return Number(result.changes || 0);
  }

  insertMeetingLedgerEntry(input: KnowledgeMeetingLedgerEntryInput): KnowledgeMeetingLedgerEntry {
    const now = input.updatedAt || new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_meeting_ledger (
          id, user_id, persona_id, counterpart, topic_key, date, decisions_json, negotiated_terms_json, open_points_json, action_items_json, source_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.counterpart,
        input.topicKey,
        input.date,
        JSON.stringify(normalizeArray(input.decisions)),
        JSON.stringify(normalizeArray(input.negotiatedTerms)),
        JSON.stringify(normalizeArray(input.openPoints)),
        JSON.stringify(normalizeArray(input.actionItems)),
        JSON.stringify(normalizeArray(input.sourceRefs)),
        now,
        now,
      );

    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_meeting_ledger
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .get(input.id, input.userId, input.personaId) as MeetingLedgerRow | undefined;
    if (!row) {
      throw new Error('Failed to insert knowledge meeting ledger entry.');
    }
    return toMeetingLedgerEntry(row);
  }

  getMeetingLedgerEntry(
    userId: string,
    personaId: string,
    id: string,
  ): KnowledgeMeetingLedgerEntry | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_meeting_ledger
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .get(userId, personaId, id) as MeetingLedgerRow | undefined;
    return row ? toMeetingLedgerEntry(row) : null;
  }

  listMeetingLedgerEntries(
    userId: string,
    personaId: string,
    limit = 100,
  ): KnowledgeMeetingLedgerEntry[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM knowledge_meeting_ledger
        WHERE user_id = ? AND persona_id = ?
        ORDER BY date DESC, updated_at DESC
        LIMIT ?
      `,
      )
      .all(userId, personaId, safeLimit) as MeetingLedgerRow[];
    return rows.map(toMeetingLedgerEntry);
  }

  updateMeetingLedgerEntry(input: KnowledgeMeetingLedgerEntryUpdateInput): number {
    const updatedAt = input.updatedAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE knowledge_meeting_ledger
        SET counterpart = ?, topic_key = ?, date = ?, decisions_json = ?, negotiated_terms_json = ?, open_points_json = ?, action_items_json = ?, source_refs_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .run(
        input.counterpart,
        input.topicKey,
        input.date,
        JSON.stringify(normalizeArray(input.decisions)),
        JSON.stringify(normalizeArray(input.negotiatedTerms)),
        JSON.stringify(normalizeArray(input.openPoints)),
        JSON.stringify(normalizeArray(input.actionItems)),
        JSON.stringify(normalizeArray(input.sourceRefs)),
        updatedAt,
        input.id,
        input.userId,
        input.personaId,
      );
    return Number(result.changes || 0);
  }

  deleteMeetingLedgerEntry(userId: string, personaId: string, id: string): number {
    const result = this.db
      .prepare(
        `
        DELETE FROM knowledge_meeting_ledger
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .run(userId, personaId, id);
    return Number(result.changes || 0);
  }

  insertRetrievalAudit(input: KnowledgeRetrievalAuditInput): KnowledgeRetrievalAudit {
    const now = input.updatedAt || new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_retrieval_audit (
          id, user_id, persona_id, query_text, counterpart, topic_key, date, result_ids_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.queryText,
        input.counterpart || null,
        input.topicKey || null,
        input.date || null,
        JSON.stringify(normalizeArray(input.resultIds)),
        now,
        now,
      );

    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_retrieval_audit
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .get(input.id, input.userId, input.personaId) as RetrievalAuditRow | undefined;
    if (!row) {
      throw new Error('Failed to insert knowledge retrieval audit row.');
    }
    return toRetrievalAudit(row);
  }

  getRetrievalAudit(userId: string, personaId: string, id: string): KnowledgeRetrievalAudit | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM knowledge_retrieval_audit
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .get(userId, personaId, id) as RetrievalAuditRow | undefined;
    return row ? toRetrievalAudit(row) : null;
  }

  updateRetrievalAudit(input: KnowledgeRetrievalAuditUpdateInput): number {
    const updatedAt = input.updatedAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE knowledge_retrieval_audit
        SET query_text = ?, counterpart = ?, topic_key = ?, date = ?, result_ids_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `,
      )
      .run(
        input.queryText,
        input.counterpart || null,
        input.topicKey || null,
        input.date || null,
        JSON.stringify(normalizeArray(input.resultIds)),
        updatedAt,
        input.id,
        input.userId,
        input.personaId,
      );
    return Number(result.changes || 0);
  }

  deleteRetrievalAudit(userId: string, personaId: string, id: string): number {
    const result = this.db
      .prepare(
        `
        DELETE FROM knowledge_retrieval_audit
        WHERE user_id = ? AND persona_id = ? AND id = ?
      `,
      )
      .run(userId, personaId, id);
    return Number(result.changes || 0);
  }
}
