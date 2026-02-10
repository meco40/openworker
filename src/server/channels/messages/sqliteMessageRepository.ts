import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChannelType } from '../../../../types';
import type {
  Conversation,
  CreateConversationInput,
  MessageRepository,
  SaveMessageInput,
  StoredMessage,
} from './repository';

// ─── Row mappers ─────────────────────────────────────────────

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    channelType: row.channel_type as ChannelType,
    externalChatId: (row.external_chat_id as string) || null,
    title: row.title as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as 'user' | 'agent' | 'system',
    content: row.content as string,
    platform: row.platform as ChannelType,
    externalMsgId: (row.external_msg_id as string) || null,
    senderName: (row.sender_name as string) || null,
    metadata: (row.metadata as string) || null,
    createdAt: row.created_at as string,
  };
}

// ─── SQLite Implementation ───────────────────────────────────

export class SqliteMessageRepository implements MessageRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    if (dbPath === ':memory:') {
      this.db = new DatabaseSync(':memory:');
    } else {
      const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new DatabaseSync(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        external_chat_id TEXT,
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
  }

  // ─── Conversations ──────────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = input.title || `${input.channelType} Chat`;

    this.db
      .prepare(
        `
        INSERT INTO conversations (id, channel_type, external_chat_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(id, input.channelType, input.externalChatId || null, title, now, now);

    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toConversation(row) : null;
  }

  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
  ): Conversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE channel_type = ? AND external_chat_id = ?')
      .get(channelType, externalChatId) as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
  ): Conversation {
    const existing = this.getConversationByExternalChat(channelType, externalChatId);
    if (existing) return existing;
    return this.createConversation({ channelType, externalChatId, title });
  }

  listConversations(limit = 50): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toConversation);
  }

  updateConversationTitle(id: string, title: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, now, id);
  }

  getDefaultWebChatConversation(): Conversation {
    return this.getOrCreateConversation(ChannelType.WEBCHAT, 'default', 'WebChat');
  }

  // ─── Messages ───────────────────────────────────────────────

  saveMessage(input: SaveMessageInput): StoredMessage {
    const id = `msg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, platform, external_msg_id, sender_name, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content,
        input.platform,
        input.externalMsgId || null,
        input.senderName || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      );

    // Touch conversation updated_at
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now, input.conversationId);

    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return toMessage(row);
  }

  listMessages(conversationId: string, limit = 100, before?: string): StoredMessage[] {
    if (before) {
      const rows = this.db
        .prepare(
          'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY rowid DESC LIMIT ?',
        )
        .all(conversationId, before, limit) as Array<Record<string, unknown>>;
      return rows.map(toMessage).reverse();
    }

    // Get the N most recent messages, then reverse to chronological order
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map(toMessage).reverse();
  }
}
