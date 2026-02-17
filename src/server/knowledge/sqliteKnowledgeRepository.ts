import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type {
  InsertRetrievalAuditInput,
  KnowledgeCheckpoint,
  KnowledgeEpisode,
  KnowledgeRepository,
  KnowledgeSourceRef,
  KnowledgeStats,
  ListKnowledgeFilter,
  MeetingLedgerEntry,
  RetrievalAuditEntry,
  UpsertKnowledgeCheckpointInput,
  UpsertKnowledgeEpisodeInput,
  UpsertMeetingLedgerInput,
} from './repository';

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseIso(input: unknown): string | null {
  const text = String(input || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asLimit(value: number | undefined, fallback = 20): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function toStringArray(values: string[]): string[] {
  return values.map((value) => String(value || '').trim()).filter((value) => value.length > 0);
}

function toSourceRefs(rows: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
  return rows
    .map((row) => ({
      seq: Number(row.seq),
      quote: String(row.quote || '').trim(),
    }))
    .filter((row) => Number.isFinite(row.seq) && row.quote.length > 0);
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(
    dbPath = process.env.KNOWLEDGE_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_ingestion_checkpoints (
        conversation_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, persona_id)
      );
    `);

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_episodes_user_persona_updated
        ON knowledge_episodes (user_id, persona_id, updated_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_counterpart_event
        ON knowledge_meeting_ledger (user_id, persona_id, counterpart, event_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_ledger_topic_event
        ON knowledge_meeting_ledger (user_id, persona_id, topic_key, event_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_audit_user_persona_created
        ON knowledge_retrieval_audit (user_id, persona_id, created_at DESC);
    `);
  }

  getIngestionCheckpoint(conversationId: string, personaId: string): KnowledgeCheckpoint | null {
    const row = this.db
      .prepare(
        `
        SELECT conversation_id, persona_id, last_seq, updated_at
        FROM knowledge_ingestion_checkpoints
        WHERE conversation_id = ? AND persona_id = ?
        LIMIT 1
      `,
      )
      .get(conversationId, personaId) as
      | {
          conversation_id: string;
          persona_id: string;
          last_seq: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      conversationId: row.conversation_id,
      personaId: row.persona_id,
      lastSeq: Number(row.last_seq || 0),
      updatedAt: row.updated_at,
    };
  }

  upsertIngestionCheckpoint(input: UpsertKnowledgeCheckpointInput): KnowledgeCheckpoint {
    const now = new Date().toISOString();
    const lastSeq = Math.max(0, Math.floor(Number(input.lastSeq || 0)));

    this.db
      .prepare(
        `
        INSERT INTO knowledge_ingestion_checkpoints (conversation_id, persona_id, last_seq, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id)
        DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
      `,
      )
      .run(input.conversationId, input.personaId, lastSeq, now);

    return {
      conversationId: input.conversationId,
      personaId: input.personaId,
      lastSeq,
      updatedAt: now,
    };
  }

  upsertEpisode(input: UpsertKnowledgeEpisodeInput): KnowledgeEpisode {
    const now = new Date().toISOString();
    const sourceSeqStart = Math.max(0, Math.floor(Number(input.sourceSeqStart || 0)));
    const sourceSeqEnd = Math.max(
      sourceSeqStart,
      Math.floor(Number(input.sourceSeqEnd || sourceSeqStart)),
    );

    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM knowledge_episodes
        WHERE conversation_id = ? AND persona_id = ? AND source_seq_start = ? AND source_seq_end = ?
        LIMIT 1
      `,
      )
      .get(input.conversationId, input.personaId, sourceSeqStart, sourceSeqEnd) as
      | { id: string }
      | undefined;

    const id = existing?.id || crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_episodes (
          id,
          user_id,
          persona_id,
          conversation_id,
          topic_key,
          counterpart,
          teaser,
          episode,
          facts_json,
          source_seq_start,
          source_seq_end,
          source_refs_json,
          event_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, source_seq_start, source_seq_end)
        DO UPDATE SET
          topic_key = excluded.topic_key,
          counterpart = excluded.counterpart,
          teaser = excluded.teaser,
          episode = excluded.episode,
          facts_json = excluded.facts_json,
          source_refs_json = excluded.source_refs_json,
          event_at = excluded.event_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        String(input.topicKey || '').trim() || 'general',
        String(input.counterpart || '').trim() || null,
        String(input.teaser || '').trim(),
        String(input.episode || '').trim(),
        JSON.stringify(toStringArray(input.facts || [])),
        sourceSeqStart,
        sourceSeqEnd,
        JSON.stringify(toSourceRefs(input.sourceRefs || [])),
        parseIso(input.eventAt) || null,
        now,
        now,
      );

    const row = this.db.prepare('SELECT * FROM knowledge_episodes WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return this.mapEpisode(row);
  }

  listEpisodes(filter: ListKnowledgeFilter): KnowledgeEpisode[] {
    const limit = asLimit(filter.limit);
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.counterpart?.trim()) {
      conditions.push("LOWER(COALESCE(counterpart, '')) LIKE ?");
      params.push(`%${filter.counterpart.trim().toLowerCase()}%`);
    }
    if (filter.topicKey?.trim()) {
      conditions.push('LOWER(topic_key) LIKE ?');
      params.push(`%${filter.topicKey.trim().toLowerCase()}%`);
    }
    const fromIso = parseIso(filter.from);
    const toIso = parseIso(filter.to);
    if (fromIso) {
      conditions.push('(event_at IS NULL OR event_at >= ?)');
      params.push(fromIso);
    }
    if (toIso) {
      conditions.push('(event_at IS NULL OR event_at <= ?)');
      params.push(toIso);
    }

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM knowledge_episodes
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(event_at, updated_at) DESC
        LIMIT ?
      `,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEpisode(row));
  }

  upsertMeetingLedger(input: UpsertMeetingLedgerInput): MeetingLedgerEntry {
    const now = new Date().toISOString();
    const eventAt = parseIso(input.eventAt);

    const existing = this.db
      .prepare(
        `
        SELECT id
        FROM knowledge_meeting_ledger
        WHERE conversation_id = ?
          AND persona_id = ?
          AND topic_key = ?
          AND COALESCE(event_at, '') = COALESCE(?, '')
        LIMIT 1
      `,
      )
      .get(
        input.conversationId,
        input.personaId,
        String(input.topicKey || '').trim() || 'general',
        eventAt,
      ) as { id: string } | undefined;

    const id = existing?.id || crypto.randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_meeting_ledger (
          id,
          user_id,
          persona_id,
          conversation_id,
          topic_key,
          counterpart,
          event_at,
          participants_json,
          decisions_json,
          negotiated_terms_json,
          open_points_json,
          action_items_json,
          source_refs_json,
          confidence,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, persona_id, topic_key, event_at)
        DO UPDATE SET
          counterpart = excluded.counterpart,
          participants_json = excluded.participants_json,
          decisions_json = excluded.decisions_json,
          negotiated_terms_json = excluded.negotiated_terms_json,
          open_points_json = excluded.open_points_json,
          action_items_json = excluded.action_items_json,
          source_refs_json = excluded.source_refs_json,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        String(input.topicKey || '').trim() || 'general',
        String(input.counterpart || '').trim() || null,
        eventAt,
        JSON.stringify(toStringArray(input.participants || [])),
        JSON.stringify(toStringArray(input.decisions || [])),
        JSON.stringify(toStringArray(input.negotiatedTerms || [])),
        JSON.stringify(toStringArray(input.openPoints || [])),
        JSON.stringify(toStringArray(input.actionItems || [])),
        JSON.stringify(toSourceRefs(input.sourceRefs || [])),
        Number.isFinite(Number(input.confidence))
          ? Math.max(0, Math.min(1, Number(input.confidence)))
          : 0.5,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM knowledge_meeting_ledger WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return this.mapLedger(row);
  }

  listMeetingLedger(filter: ListKnowledgeFilter): MeetingLedgerEntry[] {
    const limit = asLimit(filter.limit);
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.counterpart?.trim()) {
      conditions.push("LOWER(COALESCE(counterpart, '')) LIKE ?");
      params.push(`%${filter.counterpart.trim().toLowerCase()}%`);
    }
    if (filter.topicKey?.trim()) {
      conditions.push('LOWER(topic_key) LIKE ?');
      params.push(`%${filter.topicKey.trim().toLowerCase()}%`);
    }
    const fromIso = parseIso(filter.from);
    const toIso = parseIso(filter.to);
    if (fromIso) {
      conditions.push('(event_at IS NULL OR event_at >= ?)');
      params.push(fromIso);
    }
    if (toIso) {
      conditions.push('(event_at IS NULL OR event_at <= ?)');
      params.push(toIso);
    }

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM knowledge_meeting_ledger
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(event_at, updated_at) DESC
        LIMIT ?
      `,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapLedger(row));
  }

  insertRetrievalAudit(input: InsertRetrievalAuditInput): RetrievalAuditEntry {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO knowledge_retrieval_audit (
          id,
          user_id,
          persona_id,
          conversation_id,
          query_text,
          stage_stats_json,
          token_count,
          had_error,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        String(input.query || '').trim(),
        JSON.stringify(input.stageStats || {}),
        Math.max(0, Math.floor(Number(input.tokenCount || 0))),
        input.hadError ? 1 : 0,
        input.errorMessage ? String(input.errorMessage).trim() : null,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM knowledge_retrieval_audit WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown>;
    return this.mapAudit(row);
  }

  listRetrievalAudit(filter: {
    userId: string;
    personaId: string;
    limit?: number;
  }): RetrievalAuditEntry[] {
    const limit = asLimit(filter.limit, 25);
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM knowledge_retrieval_audit
        WHERE user_id = ? AND persona_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(filter.userId, filter.personaId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapAudit(row));
  }

  getKnowledgeStats(userId: string, personaId: string): KnowledgeStats {
    const episodeCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_episodes WHERE user_id = ? AND persona_id = ?',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    const ledgerCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ?',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    const retrievalErrorCount = Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) as c FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND had_error = 1',
          )
          .get(userId, personaId) as { c: number }
      ).c || 0,
    );

    void userId;
    void personaId;
    const latestCheckpoint = this.db
      .prepare(
        `
        SELECT MAX(updated_at) as updated_at
        FROM knowledge_ingestion_checkpoints
      `,
      )
      .get() as { updated_at?: string } | undefined;

    const latestIngestionAt = parseIso(latestCheckpoint?.updated_at) || null;
    const ingestionLagMs = latestIngestionAt
      ? Math.max(0, Date.now() - Date.parse(latestIngestionAt))
      : 0;

    return {
      episodeCount,
      ledgerCount,
      retrievalErrorCount,
      latestIngestionAt,
      ingestionLagMs,
    };
  }

  deleteKnowledgeByScope(userId: string, personaId: string): number {
    const tx = this.db.transaction((uid: string, pid: string) => {
      const episodeDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_episodes WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      const ledgerDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      const auditDeleted = Number(
        this.db
          .prepare('DELETE FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ?')
          .run(uid, pid).changes || 0,
      );
      return episodeDeleted + ledgerDeleted + auditDeleted;
    });

    return tx(userId, personaId);
  }

  pruneKnowledgeBefore(input: {
    userId: string;
    personaId: string;
    beforeIso: string;
    dryRun?: boolean;
  }): { episodes: number; ledger: number; audits: number } {
    const cutoff = parseIso(input.beforeIso);
    if (!cutoff) {
      return { episodes: 0, ledger: 0, audits: 0 };
    }

    const countOnly = (sql: string): number =>
      Number(
        (this.db.prepare(sql).get(input.userId, input.personaId, cutoff) as { c: number }).c || 0,
      );

    const episodes = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_episodes WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
    );
    const ledger = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
    );
    const audits = countOnly(
      'SELECT COUNT(*) as c FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND created_at < ?',
    );

    if (input.dryRun) {
      return { episodes, ledger, audits };
    }

    this.db
      .prepare(
        'DELETE FROM knowledge_episodes WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
      )
      .run(input.userId, input.personaId, cutoff);
    this.db
      .prepare(
        'DELETE FROM knowledge_meeting_ledger WHERE user_id = ? AND persona_id = ? AND COALESCE(event_at, updated_at) < ?',
      )
      .run(input.userId, input.personaId, cutoff);
    this.db
      .prepare(
        'DELETE FROM knowledge_retrieval_audit WHERE user_id = ? AND persona_id = ? AND created_at < ?',
      )
      .run(input.userId, input.personaId, cutoff);

    return { episodes, ledger, audits };
  }

  private mapEpisode(row: Record<string, unknown>): KnowledgeEpisode {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      topicKey: String(row.topic_key),
      counterpart: String(row.counterpart || '').trim() || null,
      teaser: String(row.teaser || ''),
      episode: String(row.episode || ''),
      facts: parseJsonArray<string>(row.facts_json),
      sourceSeqStart: Number(row.source_seq_start || 0),
      sourceSeqEnd: Number(row.source_seq_end || 0),
      sourceRefs: parseJsonArray<KnowledgeSourceRef>(row.source_refs_json),
      eventAt: parseIso(row.event_at),
      updatedAt: String(row.updated_at || ''),
    };
  }

  private mapLedger(row: Record<string, unknown>): MeetingLedgerEntry {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      topicKey: String(row.topic_key),
      counterpart: String(row.counterpart || '').trim() || null,
      eventAt: parseIso(row.event_at),
      participants: parseJsonArray<string>(row.participants_json),
      decisions: parseJsonArray<string>(row.decisions_json),
      negotiatedTerms: parseJsonArray<string>(row.negotiated_terms_json),
      openPoints: parseJsonArray<string>(row.open_points_json),
      actionItems: parseJsonArray<string>(row.action_items_json),
      sourceRefs: parseJsonArray<KnowledgeSourceRef>(row.source_refs_json),
      confidence: Number(row.confidence || 0),
      updatedAt: String(row.updated_at || ''),
    };
  }

  private mapAudit(row: Record<string, unknown>): RetrievalAuditEntry {
    const stageStatsRaw = parseJsonObject(row.stage_stats_json);
    const stageStats: Record<string, number> = {};
    for (const [key, value] of Object.entries(stageStatsRaw)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        stageStats[key] = numeric;
      }
    }

    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      query: String(row.query_text || ''),
      stageStats,
      tokenCount: Number(row.token_count || 0),
      hadError: Number(row.had_error || 0) === 1,
      errorMessage: String(row.error_message || '').trim() || null,
      createdAt: String(row.created_at || ''),
    };
  }
}
