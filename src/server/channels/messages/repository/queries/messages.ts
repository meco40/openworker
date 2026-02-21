import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { StoredMessage, SaveMessageInput } from '@/server/channels/messages/repository/types';
import { toMessage } from '@/server/channels/messages/messageRowMappers';

export class MessageQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

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

  findMessageByClientId(conversationId: string, clientMessageId: string): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?')
      .get(conversationId, clientMessageId) as Record<string, unknown> | undefined;
    return row ? toMessage(row) : null;
  }
}
