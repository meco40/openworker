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
import type { PhaseBufferEntry } from '@/server/agent-room/types';
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
import { ProjectQueries } from '@/server/channels/messages/repository/queries/projects';
import { AgentRoomQueries } from '@/server/channels/messages/repository/queries/agentRoom';
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
  private readonly projectQueries: ProjectQueries;
  private readonly agentRoomQueries: AgentRoomQueries;

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
    this.projectQueries = new ProjectQueries(this.db, normalizeUserId);
    this.agentRoomQueries = new AgentRoomQueries(this.db, normalizeUserId);

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

  listConversationsByPersona(personaId: string, userId: string, limit = 10_000): Conversation[] {
    return this.conversationQueries.listConversationsByPersona(personaId, userId, limit);
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

  deleteMessage(id: string, userId: string): boolean {
    return this.deleteQueries.deleteMessage(
      id,
      userId,
      this.getMessage.bind(this) as (id: string, userId?: string) => StoredMessage | null,
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

  createProject(input: {
    userId: string;
    personaId: string;
    name: string;
    workspacePath: string;
    workspaceRelativePath?: string;
  }) {
    return this.projectQueries.createProject(input);
  }

  listProjectsByPersona(personaId: string, userId: string) {
    return this.projectQueries.listProjectsByPersona(personaId, userId);
  }

  getProjectByIdOrSlug(personaId: string, userId: string, idOrSlug: string) {
    return this.projectQueries.getProjectByIdOrSlug(personaId, userId, idOrSlug);
  }

  deleteProjectByIdOrSlug(personaId: string, userId: string, idOrSlug: string) {
    return this.projectQueries.deleteProjectByIdOrSlug(personaId, userId, idOrSlug);
  }

  setActiveProjectForConversation(
    conversationId: string,
    userId: string,
    projectId: string | null,
  ) {
    return this.projectQueries.setActiveProjectForConversation(conversationId, userId, projectId);
  }

  getConversationProjectState(conversationId: string, userId: string) {
    return this.projectQueries.getConversationProjectState(conversationId, userId);
  }

  setConversationProjectGuardApproved(conversationId: string, userId: string, approved: boolean) {
    return this.projectQueries.setConversationProjectGuardApproved(
      conversationId,
      userId,
      approved,
    );
  }

  createAgentRoomSwarm(input: {
    conversationId: string;
    userId: string;
    title: string;
    task: string;
    leadPersonaId: string;
    units: Array<{ personaId: string; role: string }>;
    sessionId?: string | null;
    status?: 'idle' | 'running' | 'hold' | 'completed' | 'aborted' | 'error';
    currentPhase?: 'analysis' | 'ideation' | 'critique' | 'best_case' | 'result';
    consensusScore?: number;
    holdFlag?: boolean;
    artifact?: string;
    artifactHistory?: string[];
    friction?: {
      level: 'low' | 'medium' | 'high';
      confidence: number;
      hold: boolean;
      reasons: string[];
      updatedAt: string;
    };
    lastSeq?: number;
    searchEnabled?: boolean;
    swarmTemplate?: string | null;
    pauseBetweenPhases?: boolean;
  }) {
    return this.agentRoomQueries.createAgentRoomSwarm(input);
  }

  listAgentRoomSwarms(userId: string, limit?: number) {
    return this.agentRoomQueries.listAgentRoomSwarms(userId, limit);
  }

  listRunningSwarms(limit?: number) {
    return this.agentRoomQueries.listRunningSwarms(limit);
  }

  getAgentRoomSwarm(id: string, userId: string) {
    return this.agentRoomQueries.getAgentRoomSwarm(id, userId);
  }

  isAgentRoomConversation(conversationId: string, userId?: string): boolean {
    const normalizedUserId = userId ? this.normalizeUserId(userId) : undefined;
    return this.agentRoomQueries.isAgentRoomConversation(conversationId, normalizedUserId);
  }

  updateAgentRoomSwarm(
    id: string,
    userId: string,
    patch: {
      sessionId?: string | null;
      title?: string;
      task?: string;
      leadPersonaId?: string;
      units?: Array<{ personaId: string; role: string }>;
      status?: 'idle' | 'running' | 'hold' | 'completed' | 'aborted' | 'error';
      currentPhase?: 'analysis' | 'ideation' | 'critique' | 'best_case' | 'result';
      consensusScore?: number;
      holdFlag?: boolean;
      artifact?: string;
      artifactHistory?: string[];
      friction?: {
        level: 'low' | 'medium' | 'high';
        confidence: number;
        hold: boolean;
        reasons: string[];
        updatedAt: string;
      };
      lastSeq?: number;
      currentDeployCommandId?: string | null;
      searchEnabled?: boolean;
      swarmTemplate?: string | null;
      pauseBetweenPhases?: boolean;
      phaseBuffer?: PhaseBufferEntry[];
    },
  ) {
    return this.agentRoomQueries.updateAgentRoomSwarm(id, userId, patch);
  }

  deleteAgentRoomSwarm(id: string, userId: string) {
    return this.agentRoomQueries.deleteAgentRoomSwarm(id, userId);
  }

  getAgentRoomSwarmMetrics(userId: string) {
    return this.agentRoomQueries.getAgentRoomSwarmMetrics(userId);
  }

  close(): void {
    this.db.close();
  }
}
