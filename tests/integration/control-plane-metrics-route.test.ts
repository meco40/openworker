import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalSingletons = typeof globalThis & {
  __tokenUsageRepository?: unknown;
  __memoryRepository?: unknown;
  __memoryService?: unknown;
  __gatewayClientRegistry?: unknown;
};

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('GET /api/control-plane/metrics', () => {
  const createdDbFiles: string[] = [];

  beforeEach(async () => {
    vi.resetModules();

    const workerDbPath = uniqueDbPath('worker.metrics.route');
    const statsDbPath = uniqueDbPath('stats.metrics.route');
    const memoryDbPath = uniqueDbPath('memory.metrics.route');

    process.env.WORKER_DB_PATH = workerDbPath;
    process.env.STATS_DB_PATH = statsDbPath;
    process.env.MEMORY_DB_PATH = memoryDbPath;

    createdDbFiles.push(workerDbPath, statsDbPath, memoryDbPath);

    (globalThis as GlobalSingletons).__tokenUsageRepository = undefined;
    (globalThis as GlobalSingletons).__memoryRepository = undefined;
    (globalThis as GlobalSingletons).__memoryService = undefined;
    (globalThis as GlobalSingletons).__gatewayClientRegistry = undefined;

    const { getWorkerRepository } = await import('../../src/server/worker/workerRepository');
    const workerRepo = getWorkerRepository();

    const queued = workerRepo.createTask({
      title: 'Queued task',
      objective: 'Queued objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-open-1',
    });
    const executing = workerRepo.createTask({
      title: 'Executing task',
      objective: 'Executing objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-open-2',
    });
    const completed = workerRepo.createTask({
      title: 'Completed task',
      objective: 'Completed objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-closed-1',
    });
    const failed = workerRepo.createTask({
      title: 'Failed task',
      objective: 'Failed objective',
      originPlatform: 'WebChat' as never,
      originConversation: 'conv-closed-2',
    });

    workerRepo.updateStatus(executing.id, 'executing');
    workerRepo.updateStatus(completed.id, 'completed');
    workerRepo.updateStatus(failed.id, 'failed', { error: 'boom' });
    expect(queued.status).toBe('queued');

    const { TokenUsageRepository } = await import('../../src/server/stats/tokenUsageRepository');
    const tokenRepo = new TokenUsageRepository(process.env.STATS_DB_PATH);
    tokenRepo.recordUsage('gemini', 'gemini-2.5-pro', 10, 20, 30);
    tokenRepo.recordUsage('openai', 'gpt-4.1', 40, 30, 70);
    (globalThis as GlobalSingletons).__tokenUsageRepository = tokenRepo;

    const { SqliteMemoryRepository } = await import('../../src/server/memory/sqliteMemoryRepository');
    const { MemoryService } = await import('../../src/server/memory/service');
    const memoryRepo = new SqliteMemoryRepository(process.env.MEMORY_DB_PATH);
    const memoryService = new MemoryService(memoryRepo, async (text) =>
      text.includes('vector') ? [1, 0] : [0, 1],
    );
    await memoryService.store('fact', 'vector fact', 3);
    await memoryService.store('preference', 'another memory', 4);
    (globalThis as GlobalSingletons).__memoryRepository = memoryRepo;
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
    (globalThis as GlobalSingletons).__memoryRepository = undefined;
    (globalThis as GlobalSingletons).__memoryService = undefined;
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
    expect(typeof payload.metrics?.generatedAt).toBe('string');
  });
});
