import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_REQUESTS_PER_MINUTE } from '@/server/gateway/constants';
import { GatewayEvents } from '@/server/gateway/events';
import { getClientRegistry } from '@/server/gateway/client-registry';

type MessagePayload = string | Buffer;

class MockSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  });
}

function parseSendCall(socket: MockSocket, callIndex = 0): Record<string, unknown> {
  const raw = socket.send.mock.calls[callIndex]?.[0];
  return JSON.parse(raw);
}

function makeReq(
  id: string | number,
  method = 'test.echo',
  params?: Record<string, unknown>,
): string {
  return JSON.stringify({ type: 'req', id, method, params });
}

async function setupHandler(options?: {
  dispatchImpl?: (
    frame: { id: string | number },
    sendRaw: (data: unknown) => void,
  ) => Promise<void>;
}) {
  vi.resetModules();

  const broadcastToUser = vi.fn();
  const dispatchMethod = vi.fn(async (frame, _client, sendRaw) => {
    if (options?.dispatchImpl) {
      await options.dispatchImpl(frame, sendRaw);
      return;
    }
    sendRaw({ type: 'res', id: frame.id, ok: true, payload: { accepted: true } });
  });
  const getRegisteredMethods = vi.fn(() => ['test.echo']);

  vi.doMock('../../../src/server/gateway/broadcast', () => ({ broadcastToUser }));
  vi.doMock('../../../src/server/gateway/method-router', () => ({
    dispatchMethod,
    getRegisteredMethods,
  }));

  const mod = await import('@/server/gateway/connection-handler');
  return { ...mod, broadcastToUser, dispatchMethod, getRegisteredMethods };
}

describe('gateway connection handler', () => {
  const registry = getClientRegistry();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const client of registry.getAll()) {
      registry.unregister(client.connId);
    }
  });

  it('registers connection, sends hello-ok, and broadcasts online presence', async () => {
    const { handleConnection, broadcastToUser, getRegisteredMethods } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');

    expect(registry.getUserConnectionCount('user-a')).toBe(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(parseSendCall(socket)).toMatchObject({
      type: 'event',
      event: GatewayEvents.HELLO_OK,
      payload: {
        server: { version: expect.any(String) as string },
        events: expect.arrayContaining([GatewayEvents.HELLO_OK]),
        methods: ['test.echo'],
      },
    });
    expect(getRegisteredMethods).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenCalledWith('user-a', GatewayEvents.PRESENCE_UPDATE, {
      userId: 'user-a',
      status: 'online',
      connectionCount: 1,
    });
  });

  it('returns INVALID_REQUEST for malformed frames', async () => {
    const { handleConnection } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    socket.emit('message', Buffer.from('{broken-json') as MessagePayload);

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(parseSendCall(socket, 1)).toEqual({
      type: 'res',
      id: 'unknown',
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'Invalid frame format' },
    });
  });

  it('dispatches request frames and relays method responses while socket open', async () => {
    const { handleConnection, dispatchMethod } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    socket.emit('message', makeReq('req-1', 'test.echo', { text: 'hi' }) as MessagePayload);

    expect(dispatchMethod).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(parseSendCall(socket, 1)).toEqual({
      type: 'res',
      id: 'req-1',
      ok: true,
      payload: { accepted: true },
    });
  });

  it('rate limits requests above MAX_REQUESTS_PER_MINUTE', async () => {
    const { handleConnection, dispatchMethod } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');

    for (let i = 1; i <= MAX_REQUESTS_PER_MINUTE + 1; i++) {
      socket.emit('message', makeReq(`req-${i}`) as MessagePayload);
    }

    expect(dispatchMethod).toHaveBeenCalledTimes(MAX_REQUESTS_PER_MINUTE);
    const last = parseSendCall(socket, socket.send.mock.calls.length - 1);
    expect(last).toEqual({
      type: 'res',
      id: `req-${MAX_REQUESTS_PER_MINUTE + 1}`,
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
  });

  it('uses higher default request budget for v2 protocol connections', async () => {
    const original = process.env.AGENT_V2_MAX_REQUESTS_PER_MINUTE;
    delete process.env.AGENT_V2_MAX_REQUESTS_PER_MINUTE;

    const { handleConnection, dispatchMethod } = await setupHandler();
    const socket = new MockSocket();
    handleConnection(socket as never, 'user-a', 'v2');

    const attempts = MAX_REQUESTS_PER_MINUTE + 20;
    for (let i = 1; i <= attempts; i++) {
      socket.emit('message', makeReq(`v2-req-${i}`) as MessagePayload);
    }

    expect(dispatchMethod).toHaveBeenCalledTimes(attempts);
    const last = parseSendCall(socket, socket.send.mock.calls.length - 1);
    expect(last).not.toEqual(
      expect.objectContaining({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      }),
    );

    if (original === undefined) {
      delete process.env.AGENT_V2_MAX_REQUESTS_PER_MINUTE;
    } else {
      process.env.AGENT_V2_MAX_REQUESTS_PER_MINUTE = original;
    }
  });

  it('resets rate-limit window after 60 seconds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const { handleConnection, dispatchMethod } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    const client = registry.getByUserId('user-a')[0];
    client.requestCount = MAX_REQUESTS_PER_MINUTE;
    client.requestWindowStart = 39_000;

    socket.emit('message', makeReq('after-reset') as MessagePayload);

    expect(dispatchMethod).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(parseSendCall(socket, 1)).toEqual({
      type: 'res',
      id: 'after-reset',
      ok: true,
      payload: { accepted: true },
    });
    expect(client.requestCount).toBe(1);
    expect(client.requestWindowStart).toBe(100_000);
    now.mockRestore();
  });

  it('returns UNAVAILABLE when dispatch throws', async () => {
    const { handleConnection } = await setupHandler({
      dispatchImpl: async () => {
        throw new Error('boom');
      },
    });
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    socket.emit('message', makeReq('req-fail') as MessagePayload);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(parseSendCall(socket, 1)).toEqual({
      type: 'res',
      id: 'req-fail',
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'Internal server error' },
    });
  });

  it('drops delayed method responses after mid-stream disconnect', async () => {
    const { handleConnection, broadcastToUser } = await setupHandler({
      dispatchImpl: async (frame, sendRaw) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        sendRaw({ type: 'res', id: frame.id, ok: true, payload: { late: true } });
      },
    });
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    socket.emit('message', makeReq('req-late') as MessagePayload);
    socket.close(1006, 'disconnect');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(registry.getUserConnectionCount('user-a')).toBe(0);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(broadcastToUser).toHaveBeenLastCalledWith('user-a', GatewayEvents.PRESENCE_UPDATE, {
      userId: 'user-a',
      status: 'offline',
      connectionCount: 0,
    });
  });

  it('ignores non-request frames from clients', async () => {
    const { handleConnection, dispatchMethod } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    socket.emit('message', JSON.stringify({ type: 'event', event: 'typing' }) as MessagePayload);

    expect(dispatchMethod).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('logs socket errors without throwing', async () => {
    const { handleConnection } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    expect(() => socket.emit('error', new Error('socket-fault'))).not.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[gateway] Socket error for'),
      'socket-fault',
    );
  });

  it('marks connection alive again when pong is received', async () => {
    const { handleConnection } = await setupHandler();
    const socket = new MockSocket();

    handleConnection(socket as never, 'user-a');
    const client = registry.getByUserId('user-a')[0] as { isAlive?: boolean };
    client.isAlive = false;

    socket.emit('pong');

    expect(client.isAlive).toBe(true);
  });

  it('keeps presence online when one of multiple user connections closes', async () => {
    const { handleConnection, broadcastToUser } = await setupHandler();
    const socketA = new MockSocket();
    const socketB = new MockSocket();

    handleConnection(socketA as never, 'user-a');
    handleConnection(socketB as never, 'user-a');
    socketA.close(1000);

    expect(registry.getUserConnectionCount('user-a')).toBe(1);
    expect(broadcastToUser).toHaveBeenLastCalledWith('user-a', GatewayEvents.PRESENCE_UPDATE, {
      userId: 'user-a',
      status: 'online',
      connectionCount: 1,
    });
  });

  it('skips sending hello frame when socket is not open', async () => {
    const { handleConnection } = await setupHandler();
    const socket = new MockSocket();
    socket.readyState = 3;

    handleConnection(socket as never, 'user-a');

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('swallows hello send errors during connection setup', async () => {
    const { handleConnection } = await setupHandler();
    const socket = new MockSocket();
    socket.send = vi.fn(() => {
      throw new Error('send failed');
    });

    expect(() => handleConnection(socket as never, 'user-a')).not.toThrow();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
});
