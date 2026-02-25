import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';

type GlobalSingletons = typeof globalThis & {
  __tokenUsageRepository?: unknown;
  __memoryService?: unknown;
  __mem0Client?: unknown;
  __gatewayClientRegistry?: unknown;
  __messageRepository?: unknown;
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
    const statsDbPath = uniqueDbPath('stats.metrics.route');
    const memoryDbPath = uniqueDbPath('memory.metrics.route');

    process.env.STATS_DB_PATH = statsDbPath;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://mem0.local';
    process.env.MEM0_API_PATH = '/v1';

    createdDbFiles.push(statsDbPath, memoryDbPath);

    (globalThis as GlobalSingletons).__tokenUsageRepository = undefined;
    (globalThis as GlobalSingletons).__memoryService = undefined;
    (globalThis as GlobalSingletons).__mem0Client = undefined;
    (globalThis as GlobalSingletons).__gatewayClientRegistry = undefined;
    (globalThis as GlobalSingletons).__messageRepository = undefined;

    const { TokenUsageRepository } = await import('@/server/stats/tokenUsageRepository');
    const tokenRepo = new TokenUsageRepository(process.env.STATS_DB_PATH);
    tokenRepo.recordUsage('gemini', 'gemini-2.5-pro', 10, 20, 30);
    tokenRepo.recordUsage('openai', 'gpt-4.1', 40, 30, 70);
    (globalThis as GlobalSingletons).__tokenUsageRepository = tokenRepo;

    const { createMem0Client } = await import('@/server/memory/mem0Client');
    const { MemoryService } = await import('@/server/memory/service');
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

    const { getClientRegistry } = await import('@/server/gateway/client-registry');
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
    (globalThis as GlobalSingletons).__messageRepository = undefined;

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

  it('aggregates uptime, WS sessions, tokens today and vector node count', async () => {
    const { GET } = await import('../../app/api/control-plane/metrics/route');
    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      metrics?: {
        uptimeSeconds: number;
        activeWsSessions: number;
        tokensToday: number;
        vectorNodeCount: number;
        ramUsageBytes: number;
        agentRoom: {
          runningSwarms: number;
          holdSwarms: number;
          lastErrorAt: string | null;
        } | null;
        generatedAt: string;
      };
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metrics).toBeDefined();
    expect(payload.metrics?.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(payload.metrics?.activeWsSessions).toBe(7);
    expect(payload.metrics?.tokensToday).toBe(100);
    expect(payload.metrics?.vectorNodeCount).toBe(2);
    expect(payload.metrics?.ramUsageBytes).toBeGreaterThan(0);
    expect(typeof payload.metrics?.agentRoom?.runningSwarms).toBe('number');
    expect(typeof payload.metrics?.agentRoom?.holdSwarms).toBe('number');
    expect(typeof payload.metrics?.generatedAt).toBe('string');
  });

  it('counts vector nodes for the resolved request user context', async () => {
    const scopedUserId = 'metrics-user-scoped';
    const { getMemoryService } = await import('@/server/memory/runtime');
    const memoryService = getMemoryService();
    await memoryService.store('persona-metrics', 'fact', 'scoped memory one', 3, scopedUserId);
    await memoryService.store('persona-metrics', 'fact', 'scoped memory two', 3, scopedUserId);
    await memoryService.store('persona-metrics', 'fact', 'scoped memory three', 3, scopedUserId);

    vi.doMock('../../src/server/auth/userContext', async () => {
      const actual = await vi.importActual<typeof import('@/server/auth/userContext')>(
        '../../src/server/auth/userContext',
      );
      return {
        ...actual,
        resolveRequestUserContext: vi.fn(async () => ({
          userId: scopedUserId,
          authenticated: true,
        })),
      };
    });

    const { GET } = await import('../../app/api/control-plane/metrics/route');
    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      metrics?: {
        vectorNodeCount: number;
      };
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metrics?.vectorNodeCount).toBe(3);
  });

  it('includes channel-scoped vectors for legacy local user', async () => {
    const channelScopedUserId = 'channel:telegram:1527785051';
    const { getMemoryService } = await import('@/server/memory/runtime');
    const memoryService = getMemoryService();
    await memoryService.store(
      'persona-metrics',
      'fact',
      'channel memory one',
      3,
      channelScopedUserId,
    );
    await memoryService.store(
      'persona-metrics',
      'fact',
      'channel memory two',
      3,
      channelScopedUserId,
    );

    (globalThis as GlobalSingletons).__messageRepository = {
      listConversations: () => [
        {
          id: 'conv-telegram-1',
          channelType: ChannelType.TELEGRAM,
          externalChatId: '1527785051',
          userId: 'legacy-local-user',
          title: 'Telegram',
          modelOverride: null,
          personaId: 'persona-metrics',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    } as unknown as import('@/server/channels/messages/sqliteMessageRepository').SqliteMessageRepository;

    vi.doMock('../../src/server/auth/userContext', async () => {
      const actual = await vi.importActual<typeof import('@/server/auth/userContext')>(
        '../../src/server/auth/userContext',
      );
      return {
        ...actual,
        resolveRequestUserContext: vi.fn(async () => ({
          userId: 'legacy-local-user',
          authenticated: false,
        })),
      };
    });

    const { GET } = await import('../../app/api/control-plane/metrics/route');
    const response = await GET();
    const payload = (await response.json()) as {
      ok: boolean;
      metrics?: {
        vectorNodeCount: number;
      };
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metrics?.vectorNodeCount).toBe(4);
  });
});
