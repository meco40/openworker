// ─── Gateway Protocol Types ──────────────────────────────────
// JSON-RPC-like framing for WebSocket communication.
// Adapted from OpenClaw demo gateway protocol.

// ─── Frame Types ─────────────────────────────────────────────

export interface RequestFrame {
  type: 'req';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string | number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
}

/** Token-by-token AI streaming frame */
export interface StreamFrame {
  type: 'stream';
  id: string | number;
  delta: string;
  done: boolean;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame | StreamFrame;

// ─── Error Shape ─────────────────────────────────────────────

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BACKPRESSURE'
  | 'REPLAY_WINDOW_EXPIRED';

export interface ErrorShape {
  code: ErrorCode;
  message: string;
}

// ─── Events ──────────────────────────────────────────────────

export const GatewayEvents = {
  HELLO_OK: 'hello-ok',
  CHAT_MESSAGE: 'chat.message',
  CHAT_MESSAGE_DELETED: 'chat.message.deleted',
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
  AGENT_ROOM_SWARM: 'agent.room.swarm',
  TICK: 'tick',
} as const;

export type GatewayEvent = (typeof GatewayEvents)[keyof typeof GatewayEvents];

// ─── Method Router ───────────────────────────────────────────

export type MethodNamespace = 'v2';
