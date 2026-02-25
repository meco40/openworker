// ─── Data shapes ─────────────────────────────────────────────

import type { ChannelType, Conversation } from '@/shared/domain/types';

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
  currentDeployCommandId: string | null;
  searchEnabled: boolean;
  swarmTemplate: string | null;
  pauseBetweenPhases: boolean;
  /** Per-agent responses collected so far in the current phase (sequential execution) */
  phaseBuffer: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentRoomSwarmMetrics {
  runningSwarms: number;
  holdSwarms: number;
  lastErrorAt: string | null;
}

// ─── Search Options ───────────────────────────────────────────

export interface SearchMessagesOptions {
  userId?: string;
  conversationId?: string;
  personaId?: string;
  role?: 'user' | 'agent' | 'system';
  limit?: number;
}
