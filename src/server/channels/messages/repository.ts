import type { ChannelType, Conversation } from '@/shared/domain/types';
import type { ChannelKey } from '@/server/channels/adapters/types';
import type {
  ChannelBinding,
  ChannelBindingStatus,
  UpsertChannelBindingInput,
} from '@/server/channels/messages/channelBindings';

// Re-export SearchMessagesOptions from the queries module to maintain backward compatibility
export type { SearchMessagesOptions } from '@/server/channels/messages/repository/queries/search';

// ─── Data shapes ─────────────────────────────────────────────

export type { Conversation };

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq?: number | null;
  role: 'user' | 'agent' | 'system';
  content: string;
  platform: ChannelType;
  externalMsgId: string | null;
  senderName: string | null;
  metadata: string | null; // JSON
  createdAt: string;
}

// ─── Inputs ──────────────────────────────────────────────────

export interface CreateConversationInput {
  channelType: ChannelType;
  externalChatId?: string;
  title?: string;
  userId?: string;
  personaId?: string;
}

export interface SaveMessageInput {
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  platform: ChannelType;
  externalMsgId?: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
  clientMessageId?: string;
}

export interface ConversationContextState {
  conversationId: string;
  summaryText: string;
  summaryUptoSeq: number;
  updatedAt: string;
}

export interface PersonaProjectRecord {
  id: string;
  userId: string;
  personaId: string;
  name: string;
  slug: string;
  workspacePath: string;
  workspaceRelativePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationProjectState {
  conversationId: string;
  activeProjectId: string | null;
  guardApprovedWithoutProject: boolean;
  updatedAt: string | null;
}

export type AgentRoomSwarmStatus = 'idle' | 'running' | 'hold' | 'completed' | 'aborted' | 'error';

export type AgentRoomSwarmPhase = 'analysis' | 'ideation' | 'critique' | 'best_case' | 'result';

export interface AgentRoomSwarmUnit {
  personaId: string;
  role: string;
}

export interface AgentRoomSwarmFriction {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  hold: boolean;
  reasons: string[];
  updatedAt: string;
}

export interface AgentRoomSwarmRecord {
  id: string;
  conversationId: string;
  userId: string;
  sessionId: string | null;
  title: string;
  task: string;
  leadPersonaId: string;
  units: AgentRoomSwarmUnit[];
  status: AgentRoomSwarmStatus;
  currentPhase: AgentRoomSwarmPhase;
  consensusScore: number;
  holdFlag: boolean;
  artifact: string;
  artifactHistory: string[];
  friction: AgentRoomSwarmFriction;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoomSwarmMetrics {
  runningSwarms: number;
  holdSwarms: number;
  lastErrorAt: string | null;
}

// ─── Repository Interface ────────────────────────────────────

export interface MessageRepository {
  createConversation(input: CreateConversationInput): Conversation;
  // `userId` remains optional temporarily for legacy fallback paths.
  getConversation(id: string, userId?: string): Conversation | null;
  getConversationByExternalChat(
    channelType: ChannelType,
    externalChatId: string,
    userId?: string,
  ): Conversation | null;
  getOrCreateConversation(
    channelType: ChannelType,
    externalChatId: string,
    title?: string,
    userId?: string,
  ): Conversation;
  listConversations(limit?: number, userId?: string): Conversation[];
  listConversationsByPersona?(personaId: string, userId: string, limit?: number): Conversation[];
  updateConversationTitle(id: string, title: string): void;

  saveMessage(input: SaveMessageInput): StoredMessage;
  getMessage?(id: string, userId?: string): StoredMessage | null;
  listMessages(
    conversationId: string,
    limit?: number,
    before?: string,
    userId?: string,
  ): StoredMessage[];
  listMessagesAfterSeq?(
    conversationId: string,
    afterSeq: number,
    limit?: number,
    userId?: string,
  ): StoredMessage[];
  getDefaultWebChatConversation(userId?: string): Conversation;

  deleteConversation(id: string, userId: string): boolean;
  deleteMessage?(id: string, userId: string): boolean;
  updateModelOverride(id: string, modelOverride: string | null, userId: string): void;
  updatePersonaId(id: string, personaId: string | null, userId: string): void;
  findMessageByClientId(conversationId: string, clientMessageId: string): StoredMessage | null;
  searchMessages?(
    query: string,
    opts?: import('@/server/channels/messages/repository/queries/search').SearchMessagesOptions,
  ): Promise<StoredMessage[]> | StoredMessage[];

  getConversationContext(conversationId: string, userId?: string): ConversationContextState | null;
  upsertConversationContext(
    conversationId: string,
    summaryText: string,
    summaryUptoSeq: number,
    userId?: string,
  ): ConversationContextState;

  upsertChannelBinding?(input: UpsertChannelBindingInput): ChannelBinding;
  listChannelBindings?(userId: string): ChannelBinding[];
  getChannelBinding?(userId: string, channel: ChannelKey): ChannelBinding | null;
  updateChannelBindingPersona?(userId: string, channel: ChannelKey, personaId: string | null): void;
  touchChannelLastSeen?(
    userId: string,
    channel: ChannelKey,
    atIso?: string,
    status?: ChannelBindingStatus,
  ): void;

  createProject?(input: {
    userId: string;
    personaId: string;
    name: string;
    workspacePath: string;
    workspaceRelativePath?: string;
  }): PersonaProjectRecord;
  listProjectsByPersona?(personaId: string, userId: string): PersonaProjectRecord[];
  getProjectByIdOrSlug?(
    personaId: string,
    userId: string,
    idOrSlug: string,
  ): PersonaProjectRecord | null;
  deleteProjectByIdOrSlug?(
    personaId: string,
    userId: string,
    idOrSlug: string,
  ): PersonaProjectRecord | null;
  setActiveProjectForConversation?(
    conversationId: string,
    userId: string,
    projectId: string | null,
  ): void;
  getConversationProjectState?(conversationId: string, userId: string): ConversationProjectState;
  setConversationProjectGuardApproved?(
    conversationId: string,
    userId: string,
    approved: boolean,
  ): void;

  createAgentRoomSwarm?(input: {
    conversationId: string;
    userId: string;
    title: string;
    task: string;
    leadPersonaId: string;
    units: AgentRoomSwarmUnit[];
    sessionId?: string | null;
    status?: AgentRoomSwarmStatus;
    currentPhase?: AgentRoomSwarmPhase;
    consensusScore?: number;
    holdFlag?: boolean;
    artifact?: string;
    artifactHistory?: string[];
    friction?: AgentRoomSwarmFriction;
    lastSeq?: number;
    searchEnabled?: boolean;
    swarmTemplate?: string | null;
    pauseBetweenPhases?: boolean;
  }): AgentRoomSwarmRecord;
  listAgentRoomSwarms?(userId: string, limit?: number): AgentRoomSwarmRecord[];
  listRunningSwarms?(limit?: number): AgentRoomSwarmRecord[];
  getAgentRoomSwarm?(id: string, userId: string): AgentRoomSwarmRecord | null;
  isAgentRoomConversation?(conversationId: string, userId?: string): boolean;
  updateAgentRoomSwarm?(
    id: string,
    userId: string,
    patch: {
      sessionId?: string | null;
      title?: string;
      task?: string;
      leadPersonaId?: string;
      units?: AgentRoomSwarmUnit[];
      status?: AgentRoomSwarmStatus;
      currentPhase?: AgentRoomSwarmPhase;
      consensusScore?: number;
      holdFlag?: boolean;
      artifact?: string;
      artifactHistory?: string[];
      friction?: AgentRoomSwarmFriction;
      lastSeq?: number;
      currentDeployCommandId?: string | null;
      searchEnabled?: boolean;
      swarmTemplate?: string | null;
      pauseBetweenPhases?: boolean;
      phaseBuffer?: string[];
    },
  ): AgentRoomSwarmRecord | null;
  deleteAgentRoomSwarm?(id: string, userId: string): boolean;
  getAgentRoomSwarmMetrics?(userId: string): AgentRoomSwarmMetrics;
}
