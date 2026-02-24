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
  conversationId: string;
  channelType: string;
  updatedAt: string;
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

export interface HelloOkPayload {
  server: { version: string };
  events: string[];
  methods: string[];
}

export const GatewayEvents = {
  HELLO_OK: 'hello-ok',
  CHAT_MESSAGE: 'chat.message',
  CHAT_STREAM: 'chat.stream',
  CHAT_ABORTED: 'chat.aborted',
  CONVERSATION_DELETED: 'conversation.deleted',
  CONVERSATION_RESET: 'conversation.reset',
  PERSONA_CHANGED: 'persona.changed',
  LOG_ENTRY: 'log.entry',
  PRESENCE_UPDATE: 'presence.update',
  CHANNELS_STATUS: 'channels.status',
  INBOX_UPDATED: 'inbox.updated',
  ROOM_MESSAGE: 'room.message',
  ROOM_MEMBER_STATUS: 'room.member.status',
  ROOM_RUN_STATUS: 'room.run.status',
  ROOM_INTERVENTION: 'room.intervention',
  ROOM_METRICS: 'room.metrics',
  AGENT_V2_SESSION_UPDATED: 'agent.v2.session.updated',
  AGENT_V2_COMMAND_QUEUED: 'agent.v2.command.queued',
  AGENT_V2_COMMAND_STARTED: 'agent.v2.command.started',
  AGENT_V2_COMMAND_COMPLETED: 'agent.v2.command.completed',
  AGENT_V2_MODEL_DELTA: 'agent.v2.model.delta',
  AGENT_V2_TOOL_STARTED: 'agent.v2.tool.started',
  AGENT_V2_TOOL_COMPLETED: 'agent.v2.tool.completed',
  AGENT_V2_APPROVAL_REQUIRED: 'agent.v2.approval.required',
  AGENT_V2_SESSION_COMPLETED: 'agent.v2.session.completed',
  AGENT_V2_ERROR: 'agent.v2.error',
  TICK: 'tick',
} as const;

export type GatewayEvent = (typeof GatewayEvents)[keyof typeof GatewayEvents];
