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

// ─── Frame Parsing ───────────────────────────────────────────

export function parseFrame(raw: string): GatewayFrame | null {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return null;
    }

    switch (data.type) {
      case 'req':
        if (
          (typeof data.id !== 'string' && typeof data.id !== 'number') ||
          typeof data.method !== 'string'
        )
          return null;
        return data as RequestFrame;
      case 'res':
        if (
          (typeof data.id !== 'string' && typeof data.id !== 'number') ||
          typeof data.ok !== 'boolean'
        )
          return null;
        return data as ResponseFrame;
      case 'event':
        if (typeof data.event !== 'string') return null;
        return data as EventFrame;
      case 'stream':
        if (
          (typeof data.id !== 'string' && typeof data.id !== 'number') ||
          typeof data.delta !== 'string'
        )
          return null;
        return data as StreamFrame;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

export function makeResponse(id: string | number, payload: unknown): ResponseFrame {
  return { type: 'res', id, ok: true, payload };
}

export function makeError(id: string | number, code: ErrorCode, message: string): ResponseFrame {
  return { type: 'res', id, ok: false, error: { code, message } };
}

export function makeEvent(event: string, payload?: unknown, seq?: number): EventFrame {
  return { type: 'event', event, payload, seq };
}

export function makeStream(id: string | number, delta: string, done: boolean): StreamFrame {
  return { type: 'stream', id, delta, done };
}
