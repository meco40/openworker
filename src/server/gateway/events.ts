// ─── Gateway Event Types ─────────────────────────────────────
// Typed event payloads for all WebSocket events.

import type { ChannelType } from '../../../types';

// ─── Chat Events ─────────────────────────────────────────────

export interface ChatMessagePayload {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
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
// ─── Worker Events ───────────────────────────────────────────

export interface WorkerStatusPayload {
  taskId: string;
  status: string;
  message: string;
  timestamp: string;
}

export interface WorkerApprovalRequestPayload {
  taskId: string;
  command: string;
  description: string;
  timeout: number;
}

// ─── Log Events ──────────────────────────────────────────────

export interface LogEntryPayload {
  timestamp: string;
  type: string;
  message: string;
}

// ─── Presence Events ─────────────────────────────────────────

export interface PresenceUpdatePayload {
  userId: string;
  status: 'online' | 'offline';
  connectionCount: number;
}

// ─── Channel/Inbox Events ───────────────────────────────────

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

// ─── System Events ───────────────────────────────────────────

export interface TickPayload {
  ts: number;
}

export interface HelloOkPayload {
  server: { version: string };
  events: string[];
  methods: string[];
}

// ─── Event Name Constants ────────────────────────────────────

export const GatewayEvents = {
  HELLO_OK: 'hello-ok',
  CHAT_MESSAGE: 'chat.message',
  CHAT_STREAM: 'chat.stream',
  CHAT_ABORTED: 'chat.aborted',
  CONVERSATION_DELETED: 'conversation.deleted',
  CONVERSATION_RESET: 'conversation.reset',
  PERSONA_CHANGED: 'persona.changed',
  WORKER_STATUS: 'worker.status',
  WORKER_APPROVAL_REQUESTED: 'worker.approval.requested',
  LOG_ENTRY: 'log.entry',
  PRESENCE_UPDATE: 'presence.update',
  CHANNELS_STATUS: 'channels.status',
  INBOX_UPDATED: 'inbox.updated',
  TICK: 'tick',
} as const;

export type GatewayEvent = (typeof GatewayEvents)[keyof typeof GatewayEvents];
