import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Conversation } from '@/shared/domain/types';
import { ChannelType } from '@/shared/domain/types';
import { CreateConversationInput } from '@/server/channels/messages/repository/types';
import { toConversation } from '@/server/channels/messages/messageRowMappers';

export class ConversationQueries {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly normalizeUserId: (userId?: string) => string,
  ) {}

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
    // Exclude internal agent-room conversations – they must not appear in the regular chat UI.
    const rows = normalizedUserId
      ? (this.db
          .prepare(
            "SELECT * FROM conversations WHERE user_id = ? AND channel_type != 'AgentRoom' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(normalizedUserId, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            "SELECT * FROM conversations WHERE channel_type != 'AgentRoom' ORDER BY updated_at DESC LIMIT ?",
          )
          .all(limit) as Array<Record<string, unknown>>);
    return rows.map(toConversation);
  }

  listConversationsByPersona(personaId: string, userId: string, limit = 10_000): Conversation[] {
    const normalizedUserId = this.normalizeUserId(userId);
    const rows = this.db
      .prepare(
        'SELECT * FROM conversations WHERE user_id = ? AND persona_id = ? ORDER BY updated_at DESC LIMIT ?',
      )
      .all(normalizedUserId, personaId, limit) as Array<Record<string, unknown>>;
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
}
