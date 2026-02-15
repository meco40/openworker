import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalSingletons = typeof globalThis & {
  __tokenUsageRepository?: unknown;
  __memoryService?: unknown;
  __mem0Client?: unknown;
  __gatewayClientRegistry?: unknown;
};

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

function keyFor(userId: string, personaId: string): string {
  return `${userId}::${personaId}`;
}

describe('GET /api/control-plane/metrics', () => {
  const createdDbFiles: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    const metricsUserId = 'metrics-user';

    const workerDbPath = uniqueDbPath('worker.metrics.route');
    const statsDbPath = uniqueDbPath('stats.metrics.route');
    const memoryDbPath = uniqueDbPath('memory.metrics.route');

    process.env.WORKER_DB_PATH = workerDbPath;
    process.env.STATS_DB_PATH = statsDbPath;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';

    createdDbFiles.push(workerDbPath, statsDbPath, memoryDbPath);

    (globalThis as GlobalSingletons).__tokenUsageRepository = undefined;
    (globalThis as GlobalSingletons).__memoryService = undefined;
    (globalThis as GlobalSingletons).__mem0Client = undefined;
    (globalThis as GlobalSingletons).__gatewayClientRegistry = undefined;

    const { getWorkerRepository } = await import('../../src/server/worker/workerRepository');
    const workerRepo = getWorkerRepository();

    const queued = workerRepo.createTask({
      title: 'Queued task',
      objective: 'Queued objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-open-1',
      userId: metricsUserId,
    });
    const executing = workerRepo.createTask({
      title: 'Executing task',
      objective: 'Executing objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-open-2',
      userId: metricsUserId,
    });
    const completed = workerRepo.createTask({
      title: 'Completed task',
      objective: 'Completed objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-closed-1',
      userId: metricsUserId,
    });
    const failed = workerRepo.createTask({
      title: 'Failed task',
      objective: 'Failed objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-closed-2',
      userId: metricsUserId,
    });

    workerRepo.updateStatus(executing.id, 'executing');
    workerRepo.updateStatus(completed.id, 'completed');
    workerRepo.updateStatus(failed.id, 'failed', { error: 'boom' });
    expect(queued.status).toBe('queued');

    const flowDraft = workerRepo.createFlowDraft({
      userId: metricsUserId,
      workspaceType: 'research',
      name: 'Metrics Flow',
      graphJson: JSON.stringify({
        startNodeId: 'n1',
        nodes: [{ id: 'n1', personaId: 'persona-a' }],
        edges: [],
      }),
    });
    const flowPublished = workerRepo.publishFlowDraft(flowDraft.id, metricsUserId);
    if (!flowPublished) {
      throw new Error('Expected published flow for metrics test setup');
    }

    workerRepo.createRun({
      taskId: queued.id,
      userId: metricsUserId,
      flowPublishedId: flowPublished.id,
      status: 'running',
    });
    workerRepo.createRun({
      taskId: failed.id,
      userId: metricsUserId,
      flowPublishedId: flowPublished.id,
      status: 'failed',
    });

    const activeSubagentSession = workerRepo.createSubagentSession({
      taskId: queued.id,
      userId: metricsUserId,
      runId: null,
      nodeId: 'n1',
      personaId: 'persona-a',
      sessionRef: 'subagent-live',
      metadata: { source: 'metrics-test' },
    });
    workerRepo.updateSubagentSession(queued.id, activeSubagentSession.id, {
      status: 'running',
    });

    const { TokenUsageRepository } = await import('../../src/server/stats/tokenUsageRepository');
    const tokenRepo = new TokenUsageRepository(process.env.STATS_DB_PATH);
    tokenRepo.recordUsage('gemini', 'gemini-2.5-pro', 10, 20, 30);
    tokenRepo.recordUsage('openai', 'gpt-4.1', 40, 30, 70);
    (globalThis as GlobalSingletons).__tokenUsageRepository = tokenRepo;

    const { createMem0Client } = await import('../../src/server/memory/mem0Client');
    const { MemoryService } = await import('../../src/server/memory/service');
    const mem0Store = new Map<
      string,
      Array<{ id: string; content: string; metadata: Record<string, unknown> }>
    >();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const parsed = new URL(url);
        const method = String(init?.method || 'GET').toUpperCase();
        const body = (() => {
          if (!init?.body || typeof init.body !== 'string') return {} as Record<string, unknown>;
          try {
            return JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })();

        if (method === 'POST' && parsed.pathname.endsWith('/v1/memories')) {
          const userId = String(body.user_id || 'legacy-local-user');
          const personaId = String(body.agent_id || 'persona-default');
          const messages = Array.isArray(body.messages) ? body.messages : [];
          const content = String((messages[0] as { content?: string } | undefined)?.content || '');
          const id = `mem0-${Math.random().toString(36).slice(2, 10)}`;
          const key = keyFor(userId, personaId);
          mem0Store.set(key, [
            ...(mem0Store.get(key) || []),
            { id, content, metadata: (body.metadata as Record<string, unknown>) || {} },
          ]);
          return new Response(JSON.stringify([{ id, memory: content }]), { status: 200 });
        }

        if (method === 'POST' && parsed.pathname.endsWith('/v2/memories')) {
          const filters = (body.filters as Record<string, unknown>) || {};
          const userId = String(filters.user_id || 'legacy-local-user');
          const personaId = String(filters.agent_id || '');
          const page = Math.max(1, Math.floor(Number(body.page || 1)));
          const pageSize = Math.max(1, Math.floor(Number(body.page_size || 25)));
          const query = String(body.query || '').toLowerCase();
          const typeFilter = String(filters.type || '');
          const source = personaId
            ? mem0Store.get(keyFor(userId, personaId)) || []
            : Array.from(mem0Store.entries())
                .filter(([key]) => key.startsWith(`${userId}::`))
                .flatMap(([, rows]) => rows);
          const filtered = source.filter((row) => {
            const queryOk = query ? row.content.toLowerCase().includes(query) : true;
            const typeOk = typeFilter ? String(row.metadata.type || '') === typeFilter : true;
            return queryOk && typeOk;
          });
          const offset = (page - 1) * pageSize;
          const memories = filtered.slice(offset, offset + pageSize).map((row) => ({
            id: row.id,
            memory: row.content,
            metadata: row.metadata,
          }));
          return new Response(
            JSON.stringify({ memories, total: filtered.length, page, page_size: pageSize }),
            { status: 200 },
          );
        }

        if (method === 'POST' && parsed.pathname.endsWith('/v2/memories/search')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (method === 'GET' && parsed.pathname.includes('/v1/memories/')) {
          const id = decodeURIComponent(parsed.pathname.split('/').pop() || '');
          for (const rows of mem0Store.values()) {
            const found = rows.find((row) => row.id === id);
            if (found) {
              return new Response(
                JSON.stringify({ id: found.id, memory: found.content, metadata: found.metadata }),
                { status: 200 },
              );
            }
          }
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }

        if (method === 'PUT' && parsed.pathname.includes('/v1/memories/')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        if (method === 'DELETE' && parsed.pathname.includes('/v1/memories/')) {
          return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
        }

        if (method === 'DELETE' && parsed.pathname.endsWith('/v1/memories')) {
          return new Response(JSON.stringify({ deleted: 0 }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: `Unhandled ${method} ${parsed.pathname}` }), {
          status: 500,
        });
      },
    );
    const mem0Client = createMem0Client(
      {
        baseUrl: 'http://mem0.local',
        apiPath: '/v1',
        timeoutMs: 2000,
      },
      fetchMock as unknown as typeof fetch,
    );
    const memoryService = new MemoryService(mem0Client);
    await memoryService.store('persona-metrics', 'fact', 'vector fact', 3);
    await memoryService.store('persona-metrics', 'preference', 'another memory', 4);
    (globalThis as GlobalSingletons).__mem0Client = mem0Client;
    (globalThis as GlobalSingletons).__memoryService = memoryService;

    const { getClientRegistry } = await import('../../src/server/gateway/client-registry');
    const clientRegistry = getClientRegistry();
    for (let i = 0; i < 7; i += 1) {
      clientRegistry.register({
        connId: `conn-${i}`,
        userId: 'test-user',
        connectedAt: Date.now(),
        subscriptions: new Set<string>(),
        requestCount: 0,
        requestWindowStart: Date.now(),
        seq: 0,
        socket: {
          OPEN: 1,
          readyState: 1,
          bufferedAmount: 0,
          send: () => {},
          close: () => {},
        } as never,
      });
    }
  });

  afterEach(() => {
    (globalThis as GlobalSingletons).__tokenUsageRepository = undefined;
    (globalThis as GlobalSingletons).__memoryService = undefined;
    (globalThis as GlobalSingletons).__mem0Client = undefined;
    (globalThis as GlobalSingletons).__gatewayClientRegistry = undefined;

    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // SQLite may keep handles open briefly on Windows test runs.
        }
      }
    }
  });

  it('aggregates uptime, pending tasks, WS sessions, tokens today and vector node count', async () => {
    const { GET } = await import('../../app/api/control-plane/metrics/route');
    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      metrics?: {
        uptimeSeconds: number;
        pendingWorkerTasks: number;
        activeWsSessions: number;
        tokensToday: number;
        vectorNodeCount: number;
        orchestra: {
          runCount: number;
          failFastAbortCount: number;
          activeSubagentSessions: number;
        };
        generatedAt: string;
      };
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metrics).toBeDefined();
    expect(payload.metrics?.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(payload.metrics?.pendingWorkerTasks).toBe(2);
    expect(payload.metrics?.activeWsSessions).toBe(7);
    expect(payload.metrics?.tokensToday).toBe(100);
    expect(payload.metrics?.vectorNodeCount).toBe(2);
    expect(payload.metrics?.orchestra.runCount).toBe(2);
    expect(payload.metrics?.orchestra.failFastAbortCount).toBe(1);
    expect(payload.metrics?.orchestra.activeSubagentSessions).toBe(1);
    expect(typeof payload.metrics?.generatedAt).toBe('string');
  });
});
