import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { ChannelType } from '@/shared/domain/types';
import type {
  ConversationContextState,
  Conversation,
  CreateConversationInput,
  MessageRepository,
  SaveMessageInput,
  StoredMessage,
} from '@/server/channels/messages/repository';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import type {
  ChannelBinding,
  ChannelBindingStatus,
  UpsertChannelBindingInput,
} from '@/server/channels/messages/channelBindings';
import type { ChannelKey } from '@/server/channels/adapters/types';
import {
  toChannelBinding,
  toConversation,
  toMessage,
} from '@/server/channels/messages/messageRowMappers';

// ─── FTS5 stop words (German + English) ──────────────────────
// Common function words that add no search value and make AND-queries too restrictive.
const STOP_WORDS = new Set([
  // German
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einer',
  'einem',
  'einen',
  'ich',
  'du',
  'er',
  'sie',
  'es',
  'wir',
  'ihr',
  'mich',
  'mir',
  'dich',
  'dir',
  'sich',
  'uns',
  'euch',
  'ihm',
  'ihn',
  'ihnen',
  'mein',
  'dein',
  'sein',
  'unser',
  'ist',
  'sind',
  'war',
  'bin',
  'hat',
  'haben',
  'hatte',
  'wird',
  'werden',
  'wurde',
  'kann',
  'soll',
  'muss',
  'darf',
  'will',
  'mag',
  'könnte',
  'sollte',
  'müsste',
  'und',
  'oder',
  'aber',
  'denn',
  'weil',
  'dass',
  'wenn',
  'als',
  'ob',
  'da',
  'in',
  'an',
  'auf',
  'aus',
  'bei',
  'mit',
  'nach',
  'von',
  'zu',
  'für',
  'über',
  'um',
  'durch',
  'vor',
  'zwischen',
  'unter',
  'neben',
  'hinter',
  'wie',
  'was',
  'wer',
  'wo',
  'wann',
  'warum',
  'welche',
  'welcher',
  'welches',
  'nicht',
  'auch',
  'noch',
  'schon',
  'nur',
  'sehr',
  'mehr',
  'so',
  'ja',
  'nein',
  'hier',
  'dort',
  'jetzt',
  'dann',
  'immer',
  'nie',
  'mal',
  'doch',
  'eben',
  // English
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'its',
  'our',
  'their',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'about',
  'and',
  'or',
  'but',
  'not',
  'if',
  'so',
  'no',
  'yes',
  'this',
  'that',
  'what',
  'which',
  'who',
  'how',
  'when',
  'where',
  'why',
]);

// ─── FTS5 search options ─────────────────────────────────────

export interface SearchMessagesOptions {
  userId?: string;
  conversationId?: string;
  personaId?: string;
  role?: 'user' | 'agent' | 'system';
  limit?: number;
}

// ─── SQLite Implementation ───────────────────────────────────

export class SqliteMessageRepository implements MessageRepository {
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
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

  private normalizeUserId(userId?: string): string {
    const normalized = userId?.trim();
    return normalized ? normalized : LEGACY_LOCAL_USER_ID;
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === columnName);
  }

  private backfillMessageSeq(): void {
    const rows = this.db
      .prepare('SELECT id, conversation_id FROM messages ORDER BY rowid ASC')
      .all() as Array<{ id: string; conversation_id: string }>;

    const counters = new Map<string, number>();
    const updateStmt = this.db.prepare('UPDATE messages SET seq = ? WHERE id = ?');

    for (const row of rows) {
      const nextSeq = (counters.get(row.conversation_id) || 0) + 1;
      counters.set(row.conversation_id, nextSeq);
      updateStmt.run(nextSeq, row.id);
    }
  }

  private migrate(): void {
    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conv_external
        ON conversations (channel_type, external_chat_id);
    `);

    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_conv
        ON messages (conversation_id, created_at);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_context (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        summary_text TEXT NOT NULL DEFAULT '',
        summary_upto_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
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

    if (!this.hasColumn('conversations', 'user_id')) {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN user_id TEXT`);
      this.db
        .prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL OR user_id = ?')
        .run(LEGACY_LOCAL_USER_ID, '');
    }

    if (!this.hasColumn('messages', 'seq')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
      this.backfillMessageSeq();
    }

    // Create indexes only after additive column migrations have been applied.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conv_user_updated
        ON conversations (user_id, updated_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conv_external_user
        ON conversations (channel_type, external_chat_id, user_id);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_conv_seq
        ON messages (conversation_id, seq);
    `);

    // ─── Additive migrations (F4: Idempotency, F5: Model Override) ──
    if (!this.hasColumn('messages', 'client_message_id')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN client_message_id TEXT`);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedupe
        ON messages (conversation_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
    `);

    if (!this.hasColumn('conversations', 'model_override')) {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN model_override TEXT`);
    }

    if (!this.hasColumn('conversations', 'persona_id')) {
      this.db.exec(`ALTER TABLE conversations ADD COLUMN persona_id TEXT`);
    }

    if (!this.hasColumn('channel_bindings', 'persona_id')) {
      this.db.exec(`ALTER TABLE channel_bindings ADD COLUMN persona_id TEXT`);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channel_bindings_user_updated
        ON channel_bindings (user_id, updated_at DESC);
    `);

    // ─── FTS5 full-text search on messages ───────────────────

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    // Triggers to keep FTS5 in sync with messages table.
    // These are no-ops if triggers already exist (CREATE TRIGGER IF NOT EXISTS).
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);

    // Rebuild FTS index for any existing rows inserted before triggers existed.
    // 'rebuild' is idempotent — it truncates and re-indexes from the content table.
    this.migrateFtsRebuild();
  }

  // ─── Conversations ──────────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = input.title || `${input.channelType} Chat`;
    const userId = this.normalizeUserId(input.userId);

    this.db
      .prepare(
        `
        INSERT INTO conversations (id, channel_type, external_chat_id, user_id, title, persona_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.channelType,
        input.externalChatId || null,
        userId,
        title,
        input.personaId || null,
        now,
        now,
      );

    return this.getConversation(id, userId)!;
  }

  getConversation(id: string, userId?: string): Conversation | null {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : null;
    const row = normalizedUserId
      ? (this.db
          .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
          .get(id, normalizedUserId) as Record<string, unknown> | undefined)
      : (this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined);
    return row ? toConversation(row) : null;
  }

  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
    userId?: string,
  ): Conversation | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const row = this.db
      .prepare(
        'SELECT * FROM conversations WHERE channel_type = ? AND external_chat_id = ? AND user_id = ?',
      )
      .get(channelType, externalChatId, normalizedUserId) as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    const normalizedUserId = this.normalizeUserId(userId);
    const existing = this.getConversationByExternalChat(
      channelType,
      externalChatId,
      normalizedUserId,
    );
    if (existing) return existing;
    return this.createConversation({
      channelType,
      externalChatId,
      title,
      userId: normalizedUserId,
    });
  }

  listConversations(limit = 50, userId?: string): Conversation[] {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : null;
    const rows = normalizedUserId
      ? (this.db
          .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?')
          .all(normalizedUserId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map(toConversation);
  }

  updateConversationTitle(id: string, title: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id);
  }

  getDefaultWebChatConversation(userId?: string): Conversation {
    const normalizedUserId = this.normalizeUserId(userId);
    return this.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      'WebChat',
      normalizedUserId,
    );
  }

  // ─── Messages ───────────────────────────────────────────────

  saveMessage(input: SaveMessageInput): StoredMessage {
    // Idempotency: if clientMessageId is provided, check for existing message
    if (input.clientMessageId) {
      const existing = this.findMessageByClientId(input.conversationId, input.clientMessageId);
      if (existing) return existing;
    }

    const id = `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const maxSeqRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE conversation_id = ?')
      .get(input.conversationId) as { max_seq?: number };
    const nextSeq = Number(maxSeqRow.max_seq || 0) + 1;

    this.db
      .prepare(
        `
        INSERT INTO messages (id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, client_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.conversationId,
        nextSeq,
        input.role,
        input.content,
        input.platform,
        input.externalMsgId || null,
        input.senderName || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.clientMessageId || null,
        now,
      );

    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, input.conversationId);

    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toMessage(row);
  }

  getMessage(id: string, userId?: string): StoredMessage | null {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : null;
    const row = normalizedUserId
      ? (this.db
          .prepare(
            `
            SELECT m.*
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id = ? AND c.user_id = ?
            LIMIT 1
            `,
          )
          .get(id, normalizedUserId) as Record<string, unknown> | undefined)
      : (this.db.prepare('SELECT * FROM messages WHERE id = ? LIMIT 1').get(id) as
          | Record<string, unknown>
          | undefined);
    return row ? toMessage(row) : null;
  }

  listMessages(
    conversationId: string,
    limit = 100,
    before?: string,
    userId?: string,
  ): StoredMessage[] {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : null;
    const beforeSeq = before && /^\d+$/.test(before) ? Number(before) : null;

    if (beforeSeq !== null) {
      const rows = normalizedUserId
        ? (this.db
            .prepare(
              `
              SELECT m.*
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              WHERE m.conversation_id = ? AND m.seq < ? AND c.user_id = ?
              ORDER BY m.seq DESC
              LIMIT ?
              `,
            )
            .all(conversationId, beforeSeq, normalizedUserId, limit) as Array<
            Record<string, unknown>
          >)
        : (this.db
            .prepare(
              'SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(conversationId, beforeSeq, limit) as Array<Record<string, unknown>>);
      return rows.map(toMessage).reverse();
    }

    if (before) {
      const rows = normalizedUserId
        ? (this.db
            .prepare(
              `
              SELECT m.*
              FROM messages m
              JOIN conversations c ON c.id = m.conversation_id
              WHERE m.conversation_id = ? AND m.created_at < ? AND c.user_id = ?
              ORDER BY m.seq DESC
              LIMIT ?
              `,
            )
            .all(conversationId, before, normalizedUserId, limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(
              'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY seq DESC LIMIT ?',
            )
            .all(conversationId, before, limit) as Array<Record<string, unknown>>);
      return rows.map(toMessage).reverse();
    }

    const rows = normalizedUserId
      ? (this.db
          .prepare(
            `
            SELECT m.*
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ? AND c.user_id = ?
            ORDER BY m.seq DESC
            LIMIT ?
            `,
          )
          .all(conversationId, normalizedUserId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
          .all(conversationId, limit) as Array<Record<string, unknown>>);
    return rows.map(toMessage).reverse();
  }

  listMessagesAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit = 500,
    userId?: string,
  ): StoredMessage[] {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : null;
    const safeAfterSeq = Math.max(0, Math.floor(Number(afterSeq || 0)));
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit || 500))));

    const rows = normalizedUserId
      ? (this.db
          .prepare(
            `
            SELECT m.*
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = ? AND m.seq > ? AND c.user_id = ?
            ORDER BY m.seq ASC
            LIMIT ?
            `,
          )
          .all(conversationId, safeAfterSeq, normalizedUserId, safeLimit) as Array<
          Record<string, unknown>
        >)
      : (this.db
          .prepare(
            `
            SELECT *
            FROM messages
            WHERE conversation_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?
            `,
          )
          .all(conversationId, safeAfterSeq, safeLimit) as Array<Record<string, unknown>>);

    return rows.map(toMessage);
  }

  getConversationContext(conversationId: string, userId?: string): ConversationContextState | null {
    const conversation = this.getConversation(conversationId, userId);
    if (!conversation) {
      return null;
    }

    const row = this.db
      .prepare('SELECT * FROM conversation_context WHERE conversation_id = ?')
      .get(conversationId) as
      | {
          conversation_id: string;
          summary_text: string;
          summary_upto_seq: number;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      conversationId: row.conversation_id,
      summaryText: row.summary_text,
      summaryUptoSeq: row.summary_upto_seq,
      updatedAt: row.updated_at,
    };
  }

  upsertConversationContext(
    conversationId: string,
    summaryText: string,
    summaryUptoSeq: number,
    userId?: string,
  ): ConversationContextState {
    const conversation = this.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error('Conversation not found for context update.');
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO conversation_context (conversation_id, summary_text, summary_upto_seq, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id)
        DO UPDATE SET
          summary_text = excluded.summary_text,
          summary_upto_seq = excluded.summary_upto_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(conversationId, summaryText, summaryUptoSeq, now);

    return {
      conversationId,
      summaryText,
      summaryUptoSeq,
      updatedAt: now,
    };
  }

  // ─── Delete ──────────────────────────────────────────────────

  deleteConversation(id: string, userId: string): boolean {
    const normalizedUserId = this.normalizeUserId(userId);
    const conv = this.getConversation(id, normalizedUserId);
    if (!conv) return false;

    // If FTS index is corrupted, rebuild it first so DELETE triggers succeed
    try {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('malformed') || msg.includes('corrupt')) {
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      } else {
        throw err;
      }
    }

    // Delete context + knowledge artefacts + conversation
    this.db.prepare('DELETE FROM conversation_context WHERE conversation_id = ?').run(id);
    for (const table of [
      'knowledge_ingestion_checkpoints',
      'knowledge_episodes',
      'knowledge_meeting_ledger',
      'knowledge_retrieval_audit',
    ]) {
      try {
        this.db.prepare(`DELETE FROM "${table}" WHERE conversation_id = ?`).run(id);
      } catch {
        /* table may not exist in test / memory DBs */
      }
    }
    this.db
      .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(id, normalizedUserId);
    return true;
  }

  // ─── Model Override ─────────────────────────────────────────

  updateModelOverride(id: string, modelOverride: string | null, userId: string): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE conversations SET model_override = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      )
      .run(modelOverride, now, id, normalizedUserId);
  }

  updatePersonaId(id: string, personaId: string | null, userId: string): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE conversations SET persona_id = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      )
      .run(personaId, now, id, normalizedUserId);
  }

  // ─── Idempotency ───────────────────────────────────────────

  findMessageByClientId(conversationId: string, clientMessageId: string): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?')
      .get(conversationId, clientMessageId) as Record<string, unknown> | undefined;
    return row ? toMessage(row) : null;
  }

  upsertChannelBinding(input: UpsertChannelBindingInput): ChannelBinding {
    const userId = this.normalizeUserId(input.userId);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO channel_bindings (
          user_id,
          channel,
          status,
          external_peer_id,
          peer_name,
          transport,
          metadata,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, channel)
        DO UPDATE SET
          status = excluded.status,
          external_peer_id = excluded.external_peer_id,
          peer_name = excluded.peer_name,
          transport = excluded.transport,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        userId,
        input.channel,
        input.status,
        input.externalPeerId || null,
        input.peerName || null,
        input.transport || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        null,
        now,
        now,
      );

    const row = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? AND channel = ?')
      .get(userId, input.channel) as Record<string, unknown>;
    return toChannelBinding(row);
  }

  listChannelBindings(userId: string): ChannelBinding[] {
    const normalizedUserId = this.normalizeUserId(userId);
    const rows = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? ORDER BY updated_at DESC')
      .all(normalizedUserId) as Array<Record<string, unknown>>;
    return rows.map(toChannelBinding);
  }

  getChannelBinding(userId: string, channel: ChannelKey): ChannelBinding | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const row = this.db
      .prepare('SELECT * FROM channel_bindings WHERE user_id = ? AND channel = ?')
      .get(normalizedUserId, channel) as Record<string, unknown> | undefined;
    return row ? toChannelBinding(row) : null;
  }

  updateChannelBindingPersona(userId: string, channel: ChannelKey, personaId: string | null): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE channel_bindings SET persona_id = ?, updated_at = ? WHERE user_id = ? AND channel = ?',
      )
      .run(personaId, now, normalizedUserId, channel);
  }

  touchChannelLastSeen(
    userId: string,
    channel: ChannelKey,
    atIso = new Date().toISOString(),
    status: ChannelBindingStatus = 'connected',
  ): void {
    const normalizedUserId = this.normalizeUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO channel_bindings (
          user_id,
          channel,
          status,
          external_peer_id,
          peer_name,
          transport,
          metadata,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
        ON CONFLICT(user_id, channel)
        DO UPDATE SET
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(normalizedUserId, channel, status, atIso, now, now);
  }

  private migrateFtsRebuild(): void {
    // Only rebuild once when there are existing messages not yet indexed.
    // After triggers are in place all new inserts are automatically indexed.
    const msgCount = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number }
    ).cnt;
    if (msgCount === 0) return;

    const ftsCount = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get() as { cnt: number }
    ).cnt;
    if (ftsCount >= msgCount) return;

    this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  }

  // ─── Full-Text Search ───────────────────────────────────────

  searchMessages(query: string, opts: SearchMessagesOptions = {}): StoredMessage[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    // Build FTS5 match expression — AND all tokens
    const ftsQuery = this.buildFtsQuery(trimmed);
    params.push(ftsQuery);

    if (opts.userId) {
      conditions.push('c.user_id = ?');
      params.push(opts.userId);
    }
    if (opts.conversationId) {
      conditions.push('m.conversation_id = ?');
      params.push(opts.conversationId);
    }
    if (opts.personaId) {
      conditions.push('c.persona_id = ?');
      params.push(opts.personaId);
    }
    if (opts.role) {
      conditions.push('m.role = ?');
      params.push(opts.role);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT m.*
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ?
      ${whereClause}
      ORDER BY bm25(messages_fts) ASC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  /**
   * Converts a user query string into an FTS5 MATCH expression.
   * - Otherwise, OR all non-stopword tokens for recall-friendly matching.
   * - German/English stop words are stripped to avoid overly restrictive queries.
   * - Keeps prefix wildcard semantics for trailing '*' (e.g. Type*).
   * - Never forwards raw punctuation-heavy input to MATCH to avoid syntax errors.
   */
  private buildFtsQuery(raw: string): string {
    // Extract safe token terms with optional trailing wildcard (Type*).
    // Leading/infix punctuation (e.g. *max*, (a:b), quotes) is stripped by design.
    const allTokens = (raw.match(/[\p{L}\p{N}]+(?:\*)?/gu) || [])
      .map((token) => {
        const hasWildcard = token.endsWith('*');
        const base = hasWildcard ? token.slice(0, -1) : token;
        return hasWildcard && base ? `${base}*` : base;
      })
      .filter(Boolean);
    const tokens = allTokens.filter((t) => !STOP_WORDS.has(t.replace(/\*$/, '').toLowerCase()));
    if (tokens.length === 0) {
      // All words were stop words — fall back to original tokens
      return allTokens.length <= 1 ? (allTokens[0] ?? raw) : allTokens.join(' AND ');
    }
    if (tokens.length === 1) return tokens[0];
    // Use OR semantics for recall — BM25 ranking surfaces multi-match hits first
    return tokens.join(' OR ');
  }

  close(): void {
    this.db.close();
  }
}
