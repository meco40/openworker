import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSSEManager } from '../../../src/server/channels/sse/manager';

describe('SSEManager', () => {
  beforeEach(() => {
    // Reset the global singleton between tests
    (globalThis as any).__sseManager = undefined;
  });

  it('creates a singleton instance', () => {
    const a = getSSEManager();
    const b = getSSEManager();
    expect(a).toBe(b);
  });

  it('starts with zero connections', () => {
    const mgr = getSSEManager();
    expect(mgr.connectionCount).toBe(0);
  });

  it('adds and removes clients', () => {
    const mgr = getSSEManager();
    const mockController = {
      enqueue: vi.fn(),
      close: vi.fn(),
    } as unknown as ReadableStreamDefaultController;

    const id = mgr.addClient(mockController);
    expect(mgr.connectionCount).toBe(1);

    mgr.removeClient(id);
    expect(mgr.connectionCount).toBe(0);
  });

  it('broadcasts to all connected clients', () => {
    const mgr = getSSEManager();
    const enqueue1 = vi.fn();
    const enqueue2 = vi.fn();

    mgr.addClient({ enqueue: enqueue1 } as unknown as ReadableStreamDefaultController);
    mgr.addClient({ enqueue: enqueue2 } as unknown as ReadableStreamDefaultController);

    mgr.broadcast({ type: 'message', data: { id: '1', content: 'test' } });

    expect(enqueue1).toHaveBeenCalledTimes(1);
    expect(enqueue2).toHaveBeenCalledTimes(1);

    const sentData = new TextDecoder().decode(enqueue1.mock.calls[0][0]);
    expect(sentData).toContain('event: message');
    expect(sentData).toContain('"content":"test"');
  });

  it('removes clients that throw on enqueue', () => {
    const mgr = getSSEManager();
    const badEnqueue = vi.fn().mockImplementation(() => {
      throw new Error('closed');
    });
    const goodEnqueue = vi.fn();

    mgr.addClient({ enqueue: badEnqueue } as unknown as ReadableStreamDefaultController);
    mgr.addClient({ enqueue: goodEnqueue } as unknown as ReadableStreamDefaultController);

    mgr.broadcast({ type: 'test', data: {} });

    // Bad client gets removed
    expect(mgr.connectionCount).toBe(1);
    // Good client still got the message
    expect(goodEnqueue).toHaveBeenCalledTimes(1);
  });
});
