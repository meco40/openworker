import type BetterSqlite3 from 'better-sqlite3';
import type {
  InboxItemRecord,
  InboxListInput,
  InboxListResult,
  InboxCursor,
} from '@/server/channels/messages/repository/types';
import type { ChannelType } from '@/shared/domain/types';
import { logInboxDbQuery } from '@/server/diagnostics/chatDisplayTrace';

interface InboxRow {
  conversation_id: string;
  channel_type: string;
  title: string;
  updated_at: string;
  last_message_id: string | null;
  last_message_role: 'user' | 'agent' | 'system' | null;
  last_message_content: string | null;
  last_message_created_at: string | null;
  last_message_platform: string | null;
  total_matched: number;
}

export class InboxQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

  listInbox(input: InboxListInput): InboxListResult {
    const userId = this.normalizeUserId(input.userId);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit || 50))));
    const channel = String(input.channel || '')
      .trim()
      .toLowerCase();
    const query = String(input.query || '')
      .trim()
      .toLowerCase();
    const likeQuery = `%${query}%`;
    const cursorUpdatedAt = String(input.cursor?.updatedAt || '').trim();
    const cursorConversationId = String(input.cursor?.conversationId || '').trim();

    // Correlated subquery on idx_msg_conv_seq (conversation_id, seq) — only
    // touches rows for the conversations already filtered by user_id, so the
    // engine never scans the full messages table.
    const queryStartedAt = Date.now();
    const rows = this.db
      .prepare(
        `
        SELECT
          c.id AS conversation_id,
          c.channel_type,
          c.title,
          c.updated_at,
          lm.id AS last_message_id,
          lm.role AS last_message_role,
           lm.content AS last_message_content,
           lm.created_at AS last_message_created_at,
           lm.platform AS last_message_platform,
           COUNT(*) OVER() AS total_matched
        FROM conversations c
        LEFT JOIN messages lm
          ON lm.id = (
            SELECT m.id
            FROM messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.seq DESC
            LIMIT 1
          )
        WHERE c.user_id = ?
          AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
          AND NOT EXISTS (
            SELECT 1
            FROM agent_room_swarms s
            WHERE s.conversation_id = c.id AND s.user_id = c.user_id
          )
          AND (? = '' OR LOWER(c.channel_type) = ?)
          AND (? = '' OR LOWER(c.title) LIKE ? OR LOWER(COALESCE(lm.content, '')) LIKE ?)
          AND (
            ? = ''
            OR c.updated_at < ?
            OR (c.updated_at = ? AND c.id < ?)
          )
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT ?
        `,
      )
      .all(
        userId,
        channel,
        channel,
        query,
        likeQuery,
        likeQuery,
        cursorUpdatedAt,
        cursorUpdatedAt,
        cursorUpdatedAt,
        cursorConversationId,
        limit + 1,
      ) as InboxRow[];
    const queryDurationMs = Date.now() - queryStartedAt;
    logInboxDbQuery('inbox.list.main', {
      userId,
      limit,
      channel: channel || null,
      hasQuery: Boolean(query),
      hasCursor: Boolean(cursorUpdatedAt && cursorConversationId),
      returnedRows: rows.length,
      durationMs: queryDurationMs,
    });

    const items = rows.slice(0, limit).map((row) => this.toInboxItem(row));
    const hasMore = rows.length > limit;
    const nextCursor = hasMore ? this.toCursor(items[items.length - 1]) : null;

    const totalMatched = Math.max(0, Math.floor(Number(rows[0]?.total_matched || 0)));
    logInboxDbQuery('inbox.list.countMatched', {
      userId,
      channel: channel || null,
      hasQuery: Boolean(query),
      skipped: false,
      totalMatched,
      durationMs: queryDurationMs,
    });

    return {
      items,
      limit,
      hasMore,
      nextCursor,
      totalMatched,
    };
  }

  getInboxItem(conversationId: string, userId: string): InboxItemRecord | null {
    const normalizedUserId = this.normalizeUserId(userId);
    const queryStartedAt = Date.now();
    const rows = this.db
      .prepare(
        `
        SELECT
          c.id AS conversation_id,
          c.channel_type,
          c.title,
          c.updated_at,
          lm.id AS last_message_id,
          lm.role AS last_message_role,
          lm.content AS last_message_content,
          lm.created_at AS last_message_created_at,
          lm.platform AS last_message_platform
        FROM conversations c
        LEFT JOIN messages lm
          ON lm.id = (
            SELECT m.id
            FROM messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.seq DESC
            LIMIT 1
          )
        WHERE c.id = ?
          AND c.user_id = ?
          AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
          AND NOT EXISTS (
            SELECT 1
            FROM agent_room_swarms s
            WHERE s.conversation_id = c.id AND s.user_id = c.user_id
          )
        LIMIT 1
        `,
      )
      .all(conversationId, normalizedUserId) as InboxRow[];
    logInboxDbQuery('inbox.getItem.main', {
      userId: normalizedUserId,
      conversationId,
      returnedRows: rows.length,
      durationMs: Date.now() - queryStartedAt,
    });

    if (rows.length === 0) {
      return null;
    }
    return this.toInboxItem(rows[0]);
  }

  private toInboxItem(row: InboxRow): InboxItemRecord {
    return {
      conversationId: row.conversation_id,
      channelType: row.channel_type as ChannelType,
      title: row.title,
      updatedAt: row.updated_at,
      lastMessage: row.last_message_id
        ? {
            id: row.last_message_id,
            role: (row.last_message_role || 'user') as 'user' | 'agent' | 'system',
            content: row.last_message_content || '',
            createdAt: row.last_message_created_at || row.updated_at,
            platform: (row.last_message_platform || row.channel_type) as ChannelType,
          }
        : null,
    };
  }

  private toCursor(item: InboxItemRecord | undefined): InboxCursor | null {
    if (!item) return null;
    return {
      updatedAt: item.updatedAt,
      conversationId: item.conversationId,
    };
  }
}
