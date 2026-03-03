import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSEEvent } from '@/lib/types';

// Mock console.log to suppress output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Helper to create mock controller
function createMockController() {
  return {
    enqueue: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

// Helper to reset modules and get fresh imports
async function getFreshEventsModule() {
  vi.resetModules();
  return import('@/lib/events');
}

describe('SSE Events Broadcaster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.resetModules();
  });

  describe('registerClient', () => {
    it('adds client to the set', async () => {
      const { registerClient, getSseDiagnostics } = await getFreshEventsModule();
      const controller = createMockController();

      registerClient(controller);

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.connectedClients).toBe(1);
      expect(diagnostics.totalConnections).toBe(1);
    });

    it('increments totalConnections for each registration', async () => {
      const { registerClient, getSseDiagnostics } = await getFreshEventsModule();

      registerClient(createMockController());
      registerClient(createMockController());
      registerClient(createMockController());

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.totalConnections).toBe(3);
    });

    it('prunes oldest client when max clients reached', async () => {
      // Mock MAX_SSE_CLIENTS to 2 for this test
      const originalEnv = process.env.SSE_MAX_CLIENTS;
      process.env.SSE_MAX_CLIENTS = '2';

      // Re-import to pick up new env var
      vi.resetModules();
      const { registerClient: registerFresh, getSseDiagnostics: getFreshDiagnostics } =
        await import('@/lib/events');

      const client1 = createMockController();
      const client2 = createMockController();
      const client3 = createMockController();

      registerFresh(client1);
      registerFresh(client2);
      registerFresh(client3);

      const diagnostics = getFreshDiagnostics();
      expect(diagnostics.connectedClients).toBe(2);
      expect(diagnostics.droppedConnections).toBe(1);

      // Restore env
      restoreEnv('SSE_MAX_CLIENTS', originalEnv);
    });
  });

  describe('unregisterClient', () => {
    it('removes client from the set', async () => {
      const { registerClient, unregisterClient, getSseDiagnostics } = await getFreshEventsModule();
      const controller = createMockController();

      registerClient(controller);
      expect(getSseDiagnostics().connectedClients).toBe(1);

      unregisterClient(controller);
      expect(getSseDiagnostics().connectedClients).toBe(0);
    });

    it('does not throw when unregistering non-existent client', async () => {
      const { unregisterClient } = await getFreshEventsModule();
      const controller = createMockController();

      expect(() => unregisterClient(controller)).not.toThrow();
    });
  });

  describe('broadcast', () => {
    it('sends encoded event to all connected clients', async () => {
      const { registerClient, broadcast, getSseDiagnostics } = await getFreshEventsModule();

      const enqueue1 = vi.fn();
      const enqueue2 = vi.fn();

      registerClient({ enqueue: enqueue1 } as unknown as ReadableStreamDefaultController);
      registerClient({ enqueue: enqueue2 } as unknown as ReadableStreamDefaultController);

      const event: SSEEvent = {
        type: 'task_updated',
        payload: {
          id: 'task-123',
          title: 'Test Task',
          status: 'in_progress',
          priority: 'normal',
          assigned_agent_id: null,
          created_by_agent_id: null,
          workspace_id: 'ws-1',
          business_id: 'biz-1',
          created_at: '2026-03-03T10:00:00Z',
          updated_at: '2026-03-03T10:00:00Z',
        },
      };

      broadcast(event);

      const expectedData = `data: ${JSON.stringify(event)}\n\n`;
      const encoder = new TextEncoder();
      const expectedEncoded = encoder.encode(expectedData);

      expect(enqueue1).toHaveBeenCalledWith(expectedEncoded);
      expect(enqueue2).toHaveBeenCalledWith(expectedEncoded);

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.broadcastsTotal).toBe(1);
      expect(diagnostics.lastEventType).toBe('task_updated');
      expect(diagnostics.lastBroadcastAt).toBeDefined();
    });

    it('removes disconnected clients on enqueue error', async () => {
      const { registerClient, broadcast, getSseDiagnostics } = await getFreshEventsModule();

      const enqueueError = vi.fn().mockImplementation(() => {
        throw new Error('Client disconnected');
      });
      const enqueueOk = vi.fn();

      registerClient({ enqueue: enqueueError } as unknown as ReadableStreamDefaultController);
      registerClient({ enqueue: enqueueOk } as unknown as ReadableStreamDefaultController);

      const event: SSEEvent = {
        type: 'task_created',
        payload: {
          id: 'task-456',
          title: 'New Task',
          status: 'inbox',
          priority: 'normal',
          assigned_agent_id: null,
          created_by_agent_id: null,
          workspace_id: 'ws-1',
          business_id: 'biz-1',
          created_at: '2026-03-03T10:00:00Z',
          updated_at: '2026-03-03T10:00:00Z',
        },
      };

      broadcast(event);

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.connectedClients).toBe(1);
    });

    it('increments broadcastsTotal for each broadcast', async () => {
      const { broadcast, getSseDiagnostics } = await getFreshEventsModule();

      const event: SSEEvent = {
        type: 'agent_spawned',
        payload: { taskId: 'task-1', sessionId: 'session-1' },
      };

      broadcast(event);
      broadcast(event);
      broadcast(event);

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.broadcastsTotal).toBe(3);
    });

    it('updates lastEventType for each broadcast', async () => {
      const { broadcast, getSseDiagnostics } = await getFreshEventsModule();

      broadcast({ type: 'task_updated', payload: { id: '1' } });
      expect(getSseDiagnostics().lastEventType).toBe('task_updated');

      broadcast({ type: 'task_created', payload: { id: '2' } });
      expect(getSseDiagnostics().lastEventType).toBe('task_created');
    });
  });

  describe('getSseDiagnostics', () => {
    it('returns correct diagnostics structure', async () => {
      const { getSseDiagnostics } = await getFreshEventsModule();

      const diagnostics = getSseDiagnostics();

      expect(diagnostics).toHaveProperty('mode');
      expect(diagnostics).toHaveProperty('maxClients');
      expect(diagnostics).toHaveProperty('connectedClients');
      expect(diagnostics).toHaveProperty('totalConnections');
      expect(diagnostics).toHaveProperty('droppedConnections');
      expect(diagnostics).toHaveProperty('broadcastsTotal');
      expect(diagnostics).toHaveProperty('lastBroadcastAt');
      expect(diagnostics).toHaveProperty('lastEventType');
    });

    it('reports single-node-in-memory mode', async () => {
      const { getSseDiagnostics } = await getFreshEventsModule();

      const diagnostics = getSseDiagnostics();
      expect(diagnostics.mode).toBe('single-node-in-memory');
    });

    it('reports maxClients with a valid number', async () => {
      // Ensure env var is set for this test
      const originalEnv = process.env.SSE_MAX_CLIENTS;
      process.env.SSE_MAX_CLIENTS = '20';

      vi.resetModules();
      const { getSseDiagnostics } = await import('@/lib/events');

      const diagnostics = getSseDiagnostics();
      expect(typeof diagnostics.maxClients).toBe('number');
      expect(diagnostics.maxClients).toBeGreaterThan(0);
      expect(diagnostics.maxClients).toBe(20);

      restoreEnv('SSE_MAX_CLIENTS', originalEnv);
    });
  });
});
