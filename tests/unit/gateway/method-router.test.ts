import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';

import {
  registerMethod,
  dispatchMethod,
  getRegisteredMethods,
} from '../../../src/server/gateway/method-router';
import type { RequestFrame } from '../../../src/server/gateway/protocol';
import type { GatewayClient } from '../../../src/server/gateway/client-registry';

function makeMockSocket(): WebSocket {
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function makeClient(userId = 'test-user'): GatewayClient {
  return {
    socket: makeMockSocket(),
    connId: 'conn-test',
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };
}

function makeFrame(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 'req-1',
): RequestFrame {
  return { type: 'req', id, method, params };
}

describe('Method Router', () => {
  beforeEach(() => {
    // Register a test method for each test
    registerMethod('test.echo', async (params, _client, respond, _ctx) => {
      respond({ echo: params });
    });
  });

  it('registers methods and lists them', () => {
    const methods = getRegisteredMethods();
    expect(methods).toContain('test.echo');
  });

  it('dispatches to a registered method and receives response', async () => {
    const sent: unknown[] = [];
    const sendRaw = (data: unknown) => sent.push(data);

    await dispatchMethod(makeFrame('test.echo', { hello: 'world' }), makeClient(), sendRaw);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'res',
      id: 'req-1',
      ok: true,
      payload: { echo: { hello: 'world' } },
    });
  });

  it('returns error for unknown method', async () => {
    const sent: unknown[] = [];
    const sendRaw = (data: unknown) => sent.push(data);

    await dispatchMethod(makeFrame('nonexistent.method'), makeClient(), sendRaw);

    expect(sent).toHaveLength(1);
    const resp = sent[0] as { type: string; ok: boolean; error: { code: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('INVALID_REQUEST');
  });

  it('catches and returns handler errors', async () => {
    registerMethod('test.fail', async () => {
      throw new Error('Something broke');
    });

    const sent: unknown[] = [];
    const sendRaw = (data: unknown) => sent.push(data);

    await dispatchMethod(makeFrame('test.fail'), makeClient(), sendRaw);

    const resp = sent[0] as { ok: boolean; error: { code: string; message: string } };
    expect(resp.ok).toBe(false);
    expect(resp.error.code).toBe('UNAVAILABLE');
    expect(resp.error.message).toBe('Something broke');
  });

  it('passes context with requestId and sendRaw to handler', async () => {
    let capturedCtx: { requestId: string | number; sendRaw: unknown } | null = null;

    registerMethod('test.ctx', async (_params, _client, _respond, ctx) => {
      capturedCtx = ctx;
    });

    const sendRaw = vi.fn();
    await dispatchMethod(makeFrame('test.ctx', {}, 99), makeClient(), sendRaw);

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.requestId).toBe(99);
    expect(typeof capturedCtx!.sendRaw).toBe('function');
  });

  it('defaults params to empty object when undefined', async () => {
    let capturedParams: Record<string, unknown> | null = null;

    registerMethod('test.noparams', async (params, _client, respond, _ctx) => {
      capturedParams = params;
      respond('ok');
    });

    const sendRaw = vi.fn();
    await dispatchMethod({ type: 'req', id: '1', method: 'test.noparams' }, makeClient(), sendRaw);

    expect(capturedParams).toEqual({});
  });
});
