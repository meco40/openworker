import type BetterSqlite3 from 'better-sqlite3';
import type {
  InboxItemRecord,
  InboxListInput,
  InboxListResult,
  InboxCursor,
} from '@/server/channels/messages/repository/types';
import type { ChannelType } from '@/shared/domain/types';

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

    const rows = this.db
      .prepare(
        `
        WITH last_messages AS (
          SELECT m.conversation_id, m.id, m.role, m.content, m.created_at, m.platform
          FROM messages m
          JOIN (
            SELECT conversation_id, MAX(seq) AS max_seq
            FROM messages
            GROUP BY conversation_id
          ) latest
            ON latest.conversation_id = m.conversation_id
           AND latest.max_seq = m.seq
        )
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
        LEFT JOIN last_messages lm ON lm.conversation_id = c.id
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

    const items = rows.slice(0, limit).map((row) => this.toInboxItem(row));
    const hasMore = rows.length > limit;
    const nextCursor = hasMore ? this.toCursor(items[items.length - 1]) : null;

    const totalMatched = this.countMatched({
      userId,
      channel,
      query,
      likeQuery,
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
    const rows = this.db
      .prepare(
        `
        WITH last_messages AS (
          SELECT m.conversation_id, m.id, m.role, m.content, m.created_at, m.platform
          FROM messages m
          JOIN (
            SELECT conversation_id, MAX(seq) AS max_seq
            FROM messages
            GROUP BY conversation_id
          ) latest
            ON latest.conversation_id = m.conversation_id
           AND latest.max_seq = m.seq
        )
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
        LEFT JOIN last_messages lm ON lm.conversation_id = c.id
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

    if (rows.length === 0) {
      return null;
    }
    return this.toInboxItem(rows[0]);
  }

  private countMatched(input: {
    userId: string;
    channel: string;
    query: string;
    likeQuery: string;
  }): number {
    const row = this.db
      .prepare(
        `
        WITH last_messages AS (
          SELECT m.conversation_id, m.content
          FROM messages m
          JOIN (
            SELECT conversation_id, MAX(seq) AS max_seq
            FROM messages
            GROUP BY conversation_id
          ) latest
            ON latest.conversation_id = m.conversation_id
           AND latest.max_seq = m.seq
        )
        SELECT COUNT(*) AS count
        FROM conversations c
        LEFT JOIN last_messages lm ON lm.conversation_id = c.id
        WHERE c.user_id = ?
          AND LOWER(TRIM(c.channel_type)) NOT IN ('agentroom', 'agent-room', 'agent_room')
          AND NOT EXISTS (
            SELECT 1
            FROM agent_room_swarms s
            WHERE s.conversation_id = c.id AND s.user_id = c.user_id
          )
          AND (? = '' OR LOWER(c.channel_type) = ?)
          AND (? = '' OR LOWER(c.title) LIKE ? OR LOWER(COALESCE(lm.content, '')) LIKE ?)
        `,
      )
      .get(
        input.userId,
        input.channel,
        input.channel,
        input.query,
        input.likeQuery,
        input.likeQuery,
      ) as { count?: number } | undefined;

    return Number(row?.count || 0);
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
