import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockBrowserWebSocket {
  static instances: MockBrowserWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = this.CONNECTING;
  bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    MockBrowserWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = this.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  close(code?: number, reason?: string): void {
    this.readyState = this.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitFrame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe('GatewayClient requestStream timeout behavior', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockBrowserWebSocket.instances = [];
    globalThis.WebSocket = MockBrowserWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWebSocket === undefined) {
      Reflect.deleteProperty(globalThis, 'WebSocket');
    } else {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('treats stream timeout as idle timeout and resets on stream frames', async () => {
    vi.resetModules();
    const { GatewayClient } = await import('@/modules/gateway/ws-client');
    const client = new GatewayClient('ws://localhost:3000/ws');

    const requestPromise = client.requestStream(
      'chat.stream',
      { conversationId: 'conv-1', content: 'build app' },
      () => {
        // no-op
      },
    );

    await vi.advanceTimersByTimeAsync(100);
    const socket = MockBrowserWebSocket.instances[0];
    expect(socket).toBeTruthy();
    const requestFrame = JSON.parse(socket.sent[0]) as { id: string | number };

    socket.emitFrame({ type: 'stream', id: requestFrame.id, delta: '', done: false });
    await vi.advanceTimersByTimeAsync(119_000);
    socket.emitFrame({ type: 'stream', id: requestFrame.id, delta: '', done: true });

    await expect(requestPromise).resolves.toBeUndefined();
  });

  it('still rejects when no stream frame arrives within timeout', async () => {
    vi.resetModules();
    const { GatewayClient } = await import('@/modules/gateway/ws-client');
    const client = new GatewayClient('ws://localhost:3000/ws');

    const requestPromise = client.requestStream(
      'chat.stream',
      { conversationId: 'conv-1', content: 'build app' },
      () => {
        // no-op
      },
    );

    const handledRejection = requestPromise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(121_000);
    const error = await handledRejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Stream timeout: chat.stream');
  });
});
