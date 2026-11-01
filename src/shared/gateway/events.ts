import type { ChannelType } from '@/shared/domain/types';

export interface ChatMessagePayload {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  metadata?: string | null;
  platform: ChannelType;
  createdAt: string;
  seq?: number;
}

export interface ChatStreamPayload {
  conversationId: string;
  delta: string;
  done: boolean;
}

export interface ChatAbortedPayload {
  conversationId: string;
}

export interface ChatMessageDeletedPayload {
  messageId: string;
  conversationId: string | null;
}

export interface ConversationDeletedPayload {
  conversationId: string;
}

export interface ConversationResetPayload {
  oldConversationId: string;
  newConversationId: string;
}

export interface LogEntryPayload {
  timestamp: string;
  type: string;
  message: string;
}

export interface PresenceUpdatePayload {
  userId: string;
  status: 'online' | 'offline';
  connectionCount: number;
}

export interface ChannelStatusPayload {
  channel: string;
  status: string;
  peerName?: string;
  transport?: string;
  updatedAt: string;
}

export interface InboxUpdatedPayload {
  version: 'v2';
  action: 'upsert' | 'delete';
  conversationId: string;
  item: {
    conversationId: string;
    channelType: string;
    title: string;
    updatedAt: string;
    lastMessage: {
      id: string;
      role: 'user' | 'agent' | 'system';
      content: string;
      createdAt: string;
      platform: string;
    } | null;
  } | null;
  serverTs: string;
}

export interface RoomMessagePayload {
  id: string;
  roomId: string;
  seq: number;
  speakerType: 'persona' | 'system' | 'user';
  speakerPersonaId: string | null;
  content: string;
  createdAt: string;
}

export interface RoomMemberStatusPayload {
  roomId: string;
  personaId: string;
  status: 'idle' | 'busy' | 'interrupting' | 'interrupted' | 'error' | 'paused';
  reason: string | null;
  updatedAt: string;
}

export interface RoomRunStatusPayload {
  roomId: string;
  runState: 'stopped' | 'running' | 'degraded';
  updatedAt: string;
}

export interface RoomInterventionPayload {
  roomId: string;
  interventionId: string;
  note: string;
  createdAt: string;
}

export interface RoomMetricsPayload {
  roomId: string;
  messageCount: number;
  memberCount: number;
  generatedAt: string;
}

export interface TickPayload {
  ts: number;
}

export interface AgentRoomSwarmPayload {
  swarmId: string;
  status: 'created' | 'updated' | 'deleted';
  updatedAt: string;
}

export interface HelloOkPayload {
  server: { version: string };
  events: string[];
  methods: string[];
}

export { GatewayEvents, type GatewayEvent } from '@/shared/gatewayTypes';
