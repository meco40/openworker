import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockBrowserWebSocket {
  static instances: MockBrowserWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MockBrowserWebSocket.CONNECTING;
  readonly OPEN = MockBrowserWebSocket.OPEN;
  readonly CLOSING = MockBrowserWebSocket.CLOSING;
  readonly CLOSED = MockBrowserWebSocket.CLOSED;

  readyState = this.CONNECTING;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(public readonly url: string) {
    MockBrowserWebSocket.instances.push(this);
  }

  send(_data: string): void {
    // no-op
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitOpen(): void {
    this.readyState = this.OPEN;
    this.onopen?.({});
  }
}

describe('GatewayClient disconnect behavior', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.resetModules();
    MockBrowserWebSocket.instances = [];
    globalThis.WebSocket = MockBrowserWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    if (originalWebSocket === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).WebSocket;
    } else {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('does not close synchronously while socket is still connecting', async () => {
    const { GatewayClient } = await import('@/modules/gateway/ws-client');
    const client = new GatewayClient('ws://localhost:3000/ws-agent-v2');

    client.connect();
    const socket = MockBrowserWebSocket.instances[0];
    expect(socket).toBeTruthy();
    expect(socket.readyState).toBe(MockBrowserWebSocket.CONNECTING);

    client.disconnect();
    expect(socket.closeCalls).toHaveLength(0);

    socket.emitOpen();
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]).toEqual({ code: 1000, reason: 'client disconnect' });
  });
});

