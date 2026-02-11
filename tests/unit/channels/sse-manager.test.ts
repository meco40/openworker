import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSSEManager } from '../../../src/server/channels/sse/manager';

describe('SSEManager', () => {
  beforeEach(() => {
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

    const id = mgr.addClient(mockController, 'user-a');
    expect(mgr.connectionCount).toBe(1);

    mgr.removeClient(id);
    expect(mgr.connectionCount).toBe(0);
  });

  it('broadcasts to matching user when targetUserId is provided', () => {
    const mgr = getSSEManager();
    const enqueueA = vi.fn();
    const enqueueB = vi.fn();

    mgr.addClient({ enqueue: enqueueA } as unknown as ReadableStreamDefaultController, 'user-a');
    mgr.addClient({ enqueue: enqueueB } as unknown as ReadableStreamDefaultController, 'user-b');

    mgr.broadcast({ type: 'message', data: { id: '1', content: 'test' } }, 'user-a');

    expect(enqueueA).toHaveBeenCalledTimes(1);
    expect(enqueueB).toHaveBeenCalledTimes(0);
  });

  it('removes clients that throw on enqueue', () => {
    const mgr = getSSEManager();
    const badEnqueue = vi.fn().mockImplementation(() => {
      throw new Error('closed');
    });
    const goodEnqueue = vi.fn();

    mgr.addClient({ enqueue: badEnqueue } as unknown as ReadableStreamDefaultController, 'user-a');
    mgr.addClient({ enqueue: goodEnqueue } as unknown as ReadableStreamDefaultController, 'user-a');

    mgr.broadcast({ type: 'test', data: {} });

    expect(mgr.connectionCount).toBe(1);
    expect(goodEnqueue).toHaveBeenCalledTimes(1);
  });
});
