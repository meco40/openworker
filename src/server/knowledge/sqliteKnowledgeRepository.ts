import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import type {
  ConversationSummaryEntry,
  InsertRetrievalAuditInput,
  KnowledgeCheckpoint,
  KnowledgeEpisode,
  KnowledgeRepository,
  KnowledgeSourceRef,
  KnowledgeStats,
  ListKnowledgeFilter,
  MeetingLedgerEntry,
  RetrievalAuditEntry,
  UpsertConversationSummaryInput,
  UpsertKnowledgeCheckpointInput,
  UpsertKnowledgeEpisodeInput,
  UpsertMeetingLedgerInput,
} from '@/server/knowledge/repository';
import type {
  EventAggregationResult,
  KnowledgeEvent,
  KnowledgeEventFilter,
  UpsertKnowledgeEventInput,
} from '@/server/knowledge/eventTypes';
import type {
  EntityAlias,
  EntityCategory,
  EntityGraphFilter,
  EntityLookupResult,
  EntityRelation,
  KnowledgeEntity,
} from '@/server/knowledge/entityGraph';

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

    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_scope
        ON knowledge_events(user_id, persona_id, event_type, speaker_role);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_counterpart
        ON knowledge_events(user_id, persona_id, counterpart_entity);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_dates
        ON knowledge_events(user_id, persona_id, start_date, end_date);
    `);

    // ── Entity Graph tables ─────────────────────────────────
    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_scope
        ON knowledge_entities(user_id, persona_id, category);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_name
        ON knowledge_entities(user_id, persona_id, canonical_name COLLATE NOCASE);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_alias_lookup
        ON knowledge_entity_aliases(alias COLLATE NOCASE, owner);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_alias_entity
        ON knowledge_entity_aliases(entity_id);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relation_source
        ON knowledge_entity_relations(source_entity_id);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_relation_target
        ON knowledge_entity_relations(target_entity_id);
    `);

    // ── Conversation Summaries table ────────────────────────
    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_summaries_scope
        ON knowledge_conversation_summaries(user_id, persona_id, updated_at DESC);
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

  upsertEvent(input: UpsertKnowledgeEventInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_events (
          id, user_id, persona_id, conversation_id,
          event_type, speaker_role, speaker_entity, subject_entity,
          counterpart_entity, relation_label,
          start_date, end_date, day_count,
          source_seq_json, source_summary, is_confirmation, confidence,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, persona_id, event_type, subject_entity, counterpart_entity, start_date, end_date)
        DO UPDATE SET
          speaker_role = excluded.speaker_role,
          speaker_entity = excluded.speaker_entity,
          relation_label = excluded.relation_label,
          source_seq_json = excluded.source_seq_json,
          source_summary = excluded.source_summary,
          is_confirmation = excluded.is_confirmation,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.conversationId,
        input.eventType,
        input.speakerRole,
        input.speakerEntity,
        input.subjectEntity,
        input.counterpartEntity,
        input.relationLabel ?? null,
        input.startDate,
        input.endDate,
        input.dayCount,
        input.sourceSeqJson ?? '[]',
        input.sourceSummary ?? '',
        input.isConfirmation ? 1 : 0,
        input.confidence ?? 0.8,
        now,
        now,
      );
  }

  appendEventSources(eventId: string, newSeqs: number[], newSummary?: string): void {
    const row = this.db
      .prepare('SELECT source_seq_json, source_summary FROM knowledge_events WHERE id = ?')
      .get(eventId) as { source_seq_json: string; source_summary: string } | undefined;
    if (!row) return;

    const existingSeqs = parseJsonArray<number>(row.source_seq_json);
    const merged = [...new Set([...existingSeqs, ...newSeqs])].sort((a, b) => a - b);
    const summary = newSummary ? `${row.source_summary}\n${newSummary}`.trim() : row.source_summary;

    this.db
      .prepare(
        `UPDATE knowledge_events
         SET source_seq_json = ?, source_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(merged), summary, new Date().toISOString(), eventId);
  }

  listEvents(filter: KnowledgeEventFilter, limit = 100): KnowledgeEvent[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.speakerRole) {
      conditions.push('speaker_role = ?');
      params.push(filter.speakerRole);
    }
    if (filter.subjectEntity) {
      conditions.push('LOWER(subject_entity) = ?');
      params.push(filter.subjectEntity.toLowerCase());
    }
    if (filter.counterpartEntity) {
      conditions.push('LOWER(counterpart_entity) = ?');
      params.push(filter.counterpartEntity.toLowerCase());
    }
    if (filter.relationLabel) {
      conditions.push("LOWER(COALESCE(relation_label, '')) = ?");
      params.push(filter.relationLabel.toLowerCase());
    }
    if (filter.from) {
      conditions.push('end_date >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('start_date <= ?');
      params.push(filter.to);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY start_date DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEvent(row));
  }

  findOverlappingEvents(filter: KnowledgeEventFilter): KnowledgeEvent[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.speakerRole) {
      conditions.push('speaker_role = ?');
      params.push(filter.speakerRole);
    }
    if (filter.counterpartEntity) {
      conditions.push('LOWER(counterpart_entity) = ?');
      params.push(filter.counterpartEntity.toLowerCase());
    }
    if (filter.from && filter.to) {
      // Overlap: existing.start <= candidate.end AND existing.end >= candidate.start
      conditions.push('start_date <= ? AND end_date >= ?');
      params.push(filter.to, filter.from);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY start_date DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapEvent(row));
  }

  countUniqueDays(filter: KnowledgeEventFilter): EventAggregationResult {
    const events = this.listEvents(filter);
    const daySet = new Set<string>();
    const realEvents: KnowledgeEvent[] = [];

    for (const event of events) {
      if (event.isConfirmation) continue;
      realEvents.push(event);
      const start = new Date(event.startDate + 'T00:00:00Z');
      const end = new Date(event.endDate + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        daySet.add(d.toISOString().slice(0, 10));
      }
    }

    const uniqueDays = [...daySet].sort();
    return {
      uniqueDayCount: uniqueDays.length,
      uniqueDays,
      eventCount: realEvents.length,
      events,
    };
  }

  private mapEvent(row: Record<string, unknown>): KnowledgeEvent {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      eventType: String(row.event_type),
      speakerRole: String(row.speaker_role) as 'assistant' | 'user',
      speakerEntity: String(row.speaker_entity),
      subjectEntity: String(row.subject_entity),
      counterpartEntity: String(row.counterpart_entity),
      relationLabel: row.relation_label ? String(row.relation_label) : null,
      startDate: String(row.start_date),
      endDate: String(row.end_date),
      dayCount: Number(row.day_count || 0),
      sourceSeqJson: String(row.source_seq_json || '[]'),
      sourceSummary: String(row.source_summary || ''),
      isConfirmation: Number(row.is_confirmation || 0) === 1,
      confidence: Number(row.confidence || 0),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
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

  // ════════════════════════════════════════════════════════════
  // Entity Graph methods
  // ════════════════════════════════════════════════════════════

  upsertEntity(input: Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>): KnowledgeEntity {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entities (
          id, user_id, persona_id, canonical_name, category, owner, properties_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, persona_id, canonical_name, owner)
        DO UPDATE SET
          category = excluded.category,
          properties_json = excluded.properties_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.userId,
        input.personaId,
        input.canonicalName,
        input.category,
        input.owner,
        JSON.stringify(input.properties),
        now,
        now,
      );

    return { ...input, createdAt: now, updatedAt: now };
  }

  addAlias(alias: Omit<EntityAlias, 'id' | 'createdAt'>): void {
    const id = `ealias-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entity_aliases (id, entity_id, alias, alias_type, owner, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id, alias, owner) DO UPDATE SET
          alias_type = excluded.alias_type,
          confidence = excluded.confidence
        `,
      )
      .run(id, alias.entityId, alias.alias, alias.aliasType, alias.owner, alias.confidence, now);
  }

  addRelation(relation: Omit<EntityRelation, 'id' | 'createdAt' | 'updatedAt'>): void {
    const id = `erel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO knowledge_entity_relations (
          id, source_entity_id, target_entity_id, relation_type, properties_json, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
          properties_json = excluded.properties_json,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        id,
        relation.sourceEntityId,
        relation.targetEntityId,
        relation.relationType,
        JSON.stringify(relation.properties),
        relation.confidence,
        now,
        now,
      );
  }

  updateEntityProperties(entityId: string, properties: Record<string, string>): void {
    const row = this.db
      .prepare('SELECT properties_json FROM knowledge_entities WHERE id = ?')
      .get(entityId) as { properties_json: string } | undefined;
    if (!row) return;

    const existing = parseJsonObject(row.properties_json) as Record<string, string>;
    const merged = { ...existing, ...properties };
    this.db
      .prepare('UPDATE knowledge_entities SET properties_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), new Date().toISOString(), entityId);
  }

  resolveEntity(text: string, filter: EntityGraphFilter): EntityLookupResult | null {
    const normalized = text
      .toLowerCase()
      .replace(/^(mein|meine|dein|deine|sein|seine|ihr|ihre)\s+/i, '');

    // 1. Exact name match
    const byName = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?
         LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized) as Record<string, unknown> | undefined;
    if (byName) {
      return {
        entity: this.mapEntityRow(byName),
        matchedAlias: text,
        matchType: 'exact_name',
        confidence: 1.0,
      };
    }

    // 2. Alias match (including relation words)
    const byAlias = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias, a.alias_type, a.confidence AS alias_confidence
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ?
         ORDER BY a.confidence DESC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized) as Record<string, unknown> | undefined;
    if (byAlias) {
      return {
        entity: this.mapEntityRow(byAlias),
        matchedAlias: String(byAlias.matched_alias),
        matchType: 'alias',
        confidence: Number(byAlias.alias_confidence),
      };
    }

    // 3. Fuzzy match (prefix LIKE)
    const byFuzzy = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) LIKE ?
         ORDER BY LENGTH(a.alias) ASC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, `${normalized}%`) as
      | Record<string, unknown>
      | undefined;
    if (byFuzzy) {
      return {
        entity: this.mapEntityRow(byFuzzy),
        matchedAlias: String(byFuzzy.matched_alias),
        matchType: 'fuzzy',
        confidence: 0.6,
      };
    }

    return null;
  }

  resolveEntityByRelation(
    relation: string,
    owner: 'persona' | 'user',
    filter: EntityGraphFilter,
  ): EntityLookupResult | null {
    const normalized = relation.toLowerCase();
    const row = this.db
      .prepare(
        `SELECT e.*, a.alias AS matched_alias, a.confidence AS alias_confidence
         FROM knowledge_entity_aliases a
         JOIN knowledge_entities e ON e.id = a.entity_id
         WHERE e.user_id = ? AND e.persona_id = ? AND LOWER(a.alias) = ? AND a.owner = ?
         ORDER BY a.confidence DESC LIMIT 1`,
      )
      .get(filter.userId, filter.personaId, normalized, owner) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      entity: this.mapEntityRow(row),
      matchedAlias: String(row.matched_alias),
      matchType: 'relation',
      confidence: Number(row.alias_confidence),
    };
  }

  listEntities(filter: EntityGraphFilter, limit = 100): KnowledgeEntity[] {
    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [filter.userId, filter.personaId];

    if (filter.category) {
      conditions.push('category = ?');
      params.push(filter.category);
    }
    if (filter.owner) {
      conditions.push('owner = ?');
      params.push(filter.owner);
    }

    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE ${conditions.join(' AND ')}
         ORDER BY canonical_name ASC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntityRow(r));
  }

  getAliasCountsByEntityIds(entityIds: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entityId of entityIds) {
      counts[entityId] = 0;
    }
    if (entityIds.length === 0) {
      return counts;
    }

    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT entity_id, COUNT(*) AS alias_count
         FROM knowledge_entity_aliases
         WHERE entity_id IN (${placeholders})
         GROUP BY entity_id`,
      )
      .all(...entityIds) as Array<{ entity_id: string; alias_count: number }>;

    for (const row of rows) {
      counts[row.entity_id] = Number(row.alias_count || 0);
    }

    return counts;
  }

  listRelationsByEntityIds(entityIds: string[]): EntityRelation[] {
    if (entityIds.length === 0) {
      return [];
    }

    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entity_relations
         WHERE source_entity_id IN (${placeholders})
           AND target_entity_id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .all(...entityIds, ...entityIds) as Record<string, unknown>[];

    return rows.map((row) => this.mapRelationRow(row));
  }

  getEntityWithRelations(entityId: string): {
    entity: KnowledgeEntity;
    relations: EntityRelation[];
    aliases: EntityAlias[];
  } {
    const entityRow = this.db
      .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
      .get(entityId) as Record<string, unknown> | undefined;
    if (!entityRow) {
      throw new Error(`Entity ${entityId} not found`);
    }

    const relationRows = this.db
      .prepare(
        `SELECT * FROM knowledge_entity_relations
         WHERE source_entity_id = ? OR target_entity_id = ?
         ORDER BY created_at DESC`,
      )
      .all(entityId, entityId) as Record<string, unknown>[];

    const aliasRows = this.db
      .prepare('SELECT * FROM knowledge_entity_aliases WHERE entity_id = ? ORDER BY alias ASC')
      .all(entityId) as Record<string, unknown>[];

    return {
      entity: this.mapEntityRow(entityRow),
      relations: relationRows.map((r) => this.mapRelationRow(r)),
      aliases: aliasRows.map((r) => this.mapAliasRow(r)),
    };
  }

  getRelatedEntities(entityId: string, relationType?: string): KnowledgeEntity[] {
    const conditions = ['source_entity_id = ?'];
    const params: string[] = [entityId];
    if (relationType) {
      conditions.push('relation_type = ?');
      params.push(relationType);
    }

    const relationRows = this.db
      .prepare(
        `SELECT target_entity_id FROM knowledge_entity_relations
         WHERE ${conditions.join(' AND ')}`,
      )
      .all(...params) as Array<{ target_entity_id: string }>;

    const targetIds = relationRows.map((r) => r.target_entity_id);
    if (targetIds.length === 0) return [];

    const placeholders = targetIds.map(() => '?').join(',');
    const entityRows = this.db
      .prepare(`SELECT * FROM knowledge_entities WHERE id IN (${placeholders})`)
      .all(...targetIds) as Record<string, unknown>[];

    return entityRows.map((r) => this.mapEntityRow(r));
  }

  findPath(fromEntityId: string, toEntityId: string, maxDepth = 4): EntityRelation[] {
    // BFS graph traversal
    interface QueueItem {
      entityId: string;
      path: EntityRelation[];
    }

    const visited = new Set<string>([fromEntityId]);
    const queue: QueueItem[] = [{ entityId: fromEntityId, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length >= maxDepth) continue;

      const edges = this.db
        .prepare('SELECT * FROM knowledge_entity_relations WHERE source_entity_id = ?')
        .all(current.entityId) as Record<string, unknown>[];

      for (const edgeRow of edges) {
        const edge = this.mapRelationRow(edgeRow);
        if (edge.targetEntityId === toEntityId) {
          return [...current.path, edge];
        }
        if (!visited.has(edge.targetEntityId)) {
          visited.add(edge.targetEntityId);
          queue.push({
            entityId: edge.targetEntityId,
            path: [...current.path, edge],
          });
        }
      }
    }

    return [];
  }

  deleteEntity(entityId: string): void {
    // CASCADE handles aliases and relations via FK constraints
    this.db.prepare('DELETE FROM knowledge_entities WHERE id = ?').run(entityId);
  }

  deleteEntitiesByName(name: string, filter: EntityGraphFilter): number {
    const result = this.db
      .prepare(
        `DELETE FROM knowledge_entities
         WHERE user_id = ? AND persona_id = ? AND LOWER(canonical_name) = ?`,
      )
      .run(filter.userId, filter.personaId, name.toLowerCase());
    return result.changes;
  }

  private mapEntityRow(row: Record<string, unknown>): KnowledgeEntity {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      canonicalName: String(row.canonical_name),
      category: String(row.category) as EntityCategory,
      owner: String(row.owner) as 'persona' | 'user' | 'shared',
      properties: parseJsonObject(row.properties_json) as Record<string, string>,
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }

  private mapAliasRow(row: Record<string, unknown>): EntityAlias {
    return {
      id: String(row.id),
      entityId: String(row.entity_id),
      alias: String(row.alias),
      aliasType: String(row.alias_type) as 'name' | 'relation' | 'pronoun' | 'abbreviation',
      owner: String(row.owner) as 'persona' | 'user' | 'shared',
      confidence: Number(row.confidence),
      createdAt: String(row.created_at || ''),
    };
  }

  private mapRelationRow(row: Record<string, unknown>): EntityRelation {
    return {
      id: String(row.id),
      sourceEntityId: String(row.source_entity_id),
      targetEntityId: String(row.target_entity_id),
      relationType: String(row.relation_type),
      properties: parseJsonObject(row.properties_json) as Record<string, string>,
      confidence: Number(row.confidence),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    };
  }

  // ── Conversation Summaries ──────────────────────────────────

  upsertConversationSummary(input: UpsertConversationSummaryInput): ConversationSummaryEntry {
    const now = new Date().toISOString();
    const id = `csm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    const row = this.db
      .prepare(
        `SELECT id, created_at FROM knowledge_conversation_summaries
         WHERE conversation_id = ? AND persona_id = ?`,
      )
      .get(input.conversationId, input.personaId) as { id: string; created_at: string } | undefined;

    if (row) {
      this.db
        .prepare(
          `UPDATE knowledge_conversation_summaries
           SET summary_text = ?, key_topics_json = ?, entities_json = ?,
               emotional_tone = ?, message_count = ?,
               time_range_start = ?, time_range_end = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.summaryText,
          JSON.stringify(input.keyTopics),
          JSON.stringify(input.entitiesMentioned),
          input.emotionalTone,
          input.messageCount,
          input.timeRangeStart,
          input.timeRangeEnd,
          now,
          row.id,
        );

      return {
        id: row.id,
        userId: input.userId,
        personaId: input.personaId,
        conversationId: input.conversationId,
        summaryText: input.summaryText,
        keyTopics: input.keyTopics,
        entitiesMentioned: input.entitiesMentioned,
        emotionalTone: input.emotionalTone,
        messageCount: input.messageCount,
        timeRangeStart: input.timeRangeStart,
        timeRangeEnd: input.timeRangeEnd,
        createdAt: row.created_at,
        updatedAt: now,
      };
    }

    this.db
      .prepare(
        `INSERT INTO knowledge_conversation_summaries
         (id, user_id, persona_id, conversation_id, summary_text,
          key_topics_json, entities_json, emotional_tone, message_count,
          time_range_start, time_range_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.personaId,
        input.conversationId,
        input.summaryText,
        JSON.stringify(input.keyTopics),
        JSON.stringify(input.entitiesMentioned),
        input.emotionalTone,
        input.messageCount,
        input.timeRangeStart,
        input.timeRangeEnd,
        now,
        now,
      );

    return {
      id,
      userId: input.userId,
      personaId: input.personaId,
      conversationId: input.conversationId,
      summaryText: input.summaryText,
      keyTopics: input.keyTopics,
      entitiesMentioned: input.entitiesMentioned,
      emotionalTone: input.emotionalTone,
      messageCount: input.messageCount,
      timeRangeStart: input.timeRangeStart,
      timeRangeEnd: input.timeRangeEnd,
      createdAt: now,
      updatedAt: now,
    };
  }

  listConversationSummaries(filter: {
    userId: string;
    personaId: string;
    conversationId?: string;
    limit?: number;
  }): ConversationSummaryEntry[] {
    const conditions = ['user_id = ?', 'persona_id = ?'];
    const params: unknown[] = [filter.userId, filter.personaId];

    if (filter.conversationId) {
      conditions.push('conversation_id = ?');
      params.push(filter.conversationId);
    }

    const limit = Math.max(1, filter.limit || 50);
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_conversation_summaries
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      conversationId: String(row.conversation_id),
      summaryText: String(row.summary_text),
      keyTopics: parseJsonArray(row.key_topics_json),
      entitiesMentioned: parseJsonArray(row.entities_json),
      emotionalTone: row.emotional_tone ? String(row.emotional_tone) : null,
      messageCount: Number(row.message_count) || 0,
      timeRangeStart: String(row.time_range_start),
      timeRangeEnd: String(row.time_range_end),
      createdAt: String(row.created_at || ''),
      updatedAt: String(row.updated_at || ''),
    }));
  }
}
