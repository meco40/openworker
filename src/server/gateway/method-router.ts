// ─── Gateway Method Router ───────────────────────────────────
// Dispatches RPC requests to registered method handlers.

import { makeResponse, makeError } from '@/server/gateway/protocol';
import type { ErrorCode, RequestFrame } from '@/server/gateway/protocol';
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

export type MethodNamespace = 'v2';

// ─── Handler Registry ────────────────────────────────────────

const handlersByNamespace: Record<MethodNamespace, Map<string, MethodHandler>> = {
  v2: new Map<string, MethodHandler>(),
};

export function registerMethod(
  method: string,
  handler: MethodHandler,
  namespace: MethodNamespace = 'v2',
): void {
  handlersByNamespace[namespace].set(method, handler);
}

export function getRegisteredMethods(namespace: MethodNamespace = 'v2'): string[] {
  return Array.from(handlersByNamespace[namespace].keys());
}

// ─── Dispatch ────────────────────────────────────────────────

export async function dispatchMethod(
  frame: RequestFrame,
  client: GatewayClient,
  sendRaw: SendRawFn,
  namespace: MethodNamespace = 'v2',
): Promise<void> {
  const handler = handlersByNamespace[namespace].get(frame.method);

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
    sendRaw(makeError(frame.id, toErrorCode(err), message));
  }
}

function toErrorCode(error: unknown): ErrorCode {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: string }).code)
      : '';
  if (code === 'INVALID_REQUEST') return 'INVALID_REQUEST';
  if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
  if (code === 'NOT_FOUND') return 'NOT_FOUND';
  if (code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (code === 'BACKPRESSURE') return 'BACKPRESSURE';
  if (code === 'REPLAY_WINDOW_EXPIRED') return 'REPLAY_WINDOW_EXPIRED';
  return 'UNAVAILABLE';
}
