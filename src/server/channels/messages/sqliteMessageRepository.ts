import type BetterSqlite3 from 'better-sqlite3';
import type { ChannelType, Conversation } from '@/shared/domain/types';
import type {
  ConversationContextState,
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

// ─── Modular imports ─────────────────────────────────────────

import {
  createMigrationHelpers,
  runMigrations,
} from '@/server/channels/messages/repository/migrations';
import { ConversationQueries } from '@/server/channels/messages/repository/queries/conversations';
import { MessageQueries } from '@/server/channels/messages/repository/queries/messages';
import { ContextQueries } from '@/server/channels/messages/repository/queries/context';
import { ChannelBindingQueries } from '@/server/channels/messages/repository/queries/channelBindings';
import { SearchQueries } from '@/server/channels/messages/repository/queries/search';
import { DeleteQueries } from '@/server/channels/messages/repository/queries/delete';
import { openSqliteDatabase } from '@/server/db/sqlite';

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

  // Query modules
  private readonly conversationQueries: ConversationQueries;
  private readonly messageQueries: MessageQueries;
  private readonly contextQueries: ContextQueries;
  private readonly channelBindingQueries: ChannelBindingQueries;
  private readonly searchQueries: SearchQueries;
  private readonly deleteQueries: DeleteQueries;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    this.db = openSqliteDatabase({ dbPath });

    // Initialize query modules
    const normalizeUserId = this.normalizeUserId.bind(this);
    this.conversationQueries = new ConversationQueries(this.db, normalizeUserId);
    this.messageQueries = new MessageQueries(this.db, normalizeUserId);
    this.contextQueries = new ContextQueries(this.db);
    this.channelBindingQueries = new ChannelBindingQueries(this.db, normalizeUserId);
    this.searchQueries = new SearchQueries(this.db);
    this.deleteQueries = new DeleteQueries(this.db, normalizeUserId);

    this.migrate();
  }

  private normalizeUserId(userId?: string): string {
    const normalized = userId?.trim();
    return normalized ? normalized : LEGACY_LOCAL_USER_ID;
  }

  private migrate(): void {
    const helpers = createMigrationHelpers(this.db);
    runMigrations(this.db, helpers);
  }

  // ─── Conversations ──────────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    return this.conversationQueries.createConversation(input);
  }

  getConversation(id: string, userId?: string): Conversation | null {
    return this.conversationQueries.getConversation(id, userId);
  }

  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
    userId?: string,
  ): Conversation | null {
    return this.conversationQueries.getConversationByExternalChat(
      channelType,
      externalChatId,
      userId,
    );
  }

  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation {
    return this.conversationQueries.getOrCreateConversation(
      channelType,
      externalChatId,
      title,
      userId,
    );
  }

  listConversations(limit = 50, userId?: string): Conversation[] {
    return this.conversationQueries.listConversations(limit, userId);
  }

  updateConversationTitle(id: string, title: string): void {
    return this.conversationQueries.updateConversationTitle(id, title);
  }

  getDefaultWebChatConversation(userId?: string): Conversation {
    return this.conversationQueries.getDefaultWebChatConversation(userId);
  }

  // ─── Messages ───────────────────────────────────────────────

  saveMessage(input: SaveMessageInput): StoredMessage {
    return this.messageQueries.saveMessage(input);
  }

  getMessage(id: string, userId?: string): StoredMessage | null {
    return this.messageQueries.getMessage(id, userId);
  }

  listMessages(
    conversationId: string,
    limit = 100,
    before?: string,
    userId?: string,
  ): StoredMessage[] {
    return this.messageQueries.listMessages(conversationId, limit, before, userId);
  }

  listMessagesAfterSeq(
    conversationId: string,
    afterSeq: number,
    limit = 500,
    userId?: string,
  ): StoredMessage[] {
    return this.messageQueries.listMessagesAfterSeq(conversationId, afterSeq, limit, userId);
  }

  // ─── Context ────────────────────────────────────────────────

  getConversationContext(conversationId: string, userId?: string): ConversationContextState | null {
    return this.contextQueries.getConversationContext(
      conversationId,
      this.getConversation.bind(this),
      userId,
    );
  }

  upsertConversationContext(
    conversationId: string,
    summaryText: string,
    summaryUptoSeq: number,
    userId?: string,
  ): ConversationContextState {
    return this.contextQueries.upsertConversationContext(
      conversationId,
      summaryText,
      summaryUptoSeq,
      this.getConversation.bind(this),
      userId,
    );
  }

  // ─── Delete ──────────────────────────────────────────────────

  deleteConversation(id: string, userId: string): boolean {
    return this.deleteQueries.deleteConversation(
      id,
      userId,
      this.getConversation.bind(this) as (id: string, userId?: string) => Conversation | null,
    );
  }

  // ─── Model Override ─────────────────────────────────────────

  updateModelOverride(id: string, modelOverride: string | null, userId: string): void {
    return this.conversationQueries.updateModelOverride(id, modelOverride, userId);
  }

  updatePersonaId(id: string, personaId: string | null, userId: string): void {
    return this.conversationQueries.updatePersonaId(id, personaId, userId);
  }

  // ─── Idempotency ───────────────────────────────────────────

  findMessageByClientId(conversationId: string, clientMessageId: string): StoredMessage | null {
    return this.messageQueries.findMessageByClientId(conversationId, clientMessageId);
  }

  // ─── Channel Bindings ───────────────────────────────────────

  upsertChannelBinding(input: UpsertChannelBindingInput): ChannelBinding {
    return this.channelBindingQueries.upsertChannelBinding(input);
  }

  listChannelBindings(userId: string): ChannelBinding[] {
    return this.channelBindingQueries.listChannelBindings(userId);
  }

  getChannelBinding(userId: string, channel: ChannelKey): ChannelBinding | null {
    return this.channelBindingQueries.getChannelBinding(userId, channel);
  }

  updateChannelBindingPersona(userId: string, channel: ChannelKey, personaId: string | null): void {
    return this.channelBindingQueries.updateChannelBindingPersona(userId, channel, personaId);
  }

  touchChannelLastSeen(
    userId: string,
    channel: ChannelKey,
    atIso = new Date().toISOString(),
    status: ChannelBindingStatus = 'connected',
  ): void {
    return this.channelBindingQueries.touchChannelLastSeen(userId, channel, atIso, status);
  }

  // ─── Full-Text Search ───────────────────────────────────────

  searchMessages(query: string, opts: SearchMessagesOptions = {}): StoredMessage[] {
    return this.searchQueries.searchMessages(query, opts);
  }

  close(): void {
    this.db.close();
  }
}
