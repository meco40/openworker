// ─── Gateway Method Router ───────────────────────────────────
// Dispatches RPC requests to registered method handlers.

import type { RequestFrame } from '@/server/gateway/protocol';
import { makeResponse, makeError } from '@/server/gateway/protocol';
import type { GatewayClient } from '@/server/gateway/client-registry';

// ─── Types ───────────────────────────────────────────────────

export type RespondFn = (response: unknown) => void;

/** Low-level send function for streaming frames */
export type SendRawFn = (data: unknown) => void;

export type MethodHandler = (
  params: Record<string, unknown>,
  client: GatewayClient,
  respond: RespondFn,
  context: { requestId: string | number; sendRaw: SendRawFn },
) => Promise<void> | void;

// ─── Handler Registry ────────────────────────────────────────

const handlers = new Map<string, MethodHandler>();

export function registerMethod(method: string, handler: MethodHandler): void {
  handlers.set(method, handler);
}

export function getRegisteredMethods(): string[] {
  return Array.from(handlers.keys());
}

// ─── Dispatch ────────────────────────────────────────────────

export async function dispatchMethod(
  frame: RequestFrame,
  client: GatewayClient,
  sendRaw: SendRawFn,
): Promise<void> {
  const handler = handlers.get(frame.method);

  if (!handler) {
    sendRaw(makeError(frame.id, 'INVALID_REQUEST', `Unknown method: ${frame.method}`));
    return;
  }

  const params = (frame.params as Record<string, unknown>) ?? {};

  const respond: RespondFn = (result) => {
    sendRaw(makeResponse(frame.id, result));
  };

  try {
    await handler(params, client, respond, { requestId: frame.id, sendRaw });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    sendRaw(makeError(frame.id, 'UNAVAILABLE', message));
  }
}
