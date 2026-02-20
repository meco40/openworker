import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenUsageRepository } from '@/server/stats/tokenUsageRepository';
import type { Conversation } from '@/shared/domain/types';

type GlobalSingletons = typeof globalThis & {
  __tokenUsageRepository?: unknown;
  __messageRepository?: unknown;
};

describe('GET /api/stats sessions lens', () => {
  let tokenRepo: TokenUsageRepository;

  beforeEach(() => {
    vi.resetModules();
    tokenRepo = new TokenUsageRepository(':memory:');
    tokenRepo.recordUsage('openai', 'gpt-4.1', 10, 5, 15);
    tokenRepo.recordUsage('gemini', 'gemini-2.5-pro', 20, 10, 30);

    (globalThis as GlobalSingletons).__tokenUsageRepository = tokenRepo;
    (globalThis as GlobalSingletons).__messageRepository = {
      listConversations: (_limit?: number) =>
        [
          {
            id: 'conv-1',
            channelType: 'WebChat',
            externalChatId: 'default',
            userId: 'legacy-local-user',
            title: 'Ops Daily',
            modelOverride: null,
            personaId: 'persona-1',
            createdAt: '2026-02-20T00:00:00.000Z',
            updatedAt: '2026-02-20T00:10:00.000Z',
          },
          {
            id: 'conv-2',
            channelType: 'Telegram',
            externalChatId: 'tg-1',
            userId: 'legacy-local-user',
            title: 'Incident',
            modelOverride: 'gpt-4.1',
            personaId: null,
            createdAt: '2026-02-20T00:05:00.000Z',
            updatedAt: '2026-02-20T00:15:00.000Z',
          },
        ] as Conversation[],
    } as unknown as import('@/server/channels/messages/sqliteMessageRepository').SqliteMessageRepository;
  });

  afterEach(() => {
    tokenRepo.close();
    (globalThis as GlobalSingletons).__tokenUsageRepository = undefined;
    (globalThis as GlobalSingletons).__messageRepository = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns bounded session lens payload when sessions=1 is requested', async () => {
    const { GET } = await import('../../../app/api/stats/route');
    const response = await GET(new Request('http://localhost/api/stats?preset=month&sessions=1'));
    const payload = (await response.json()) as {
      ok: boolean;
      sessionLens?: {
        totalSessions: number;
        byChannel: Array<{ channelType: string; count: number }>;
        topSessions: Array<{ id: string; title: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.sessionLens).toBeDefined();
    expect(payload.sessionLens?.totalSessions).toBe(2);
    expect(payload.sessionLens?.topSessions).toHaveLength(2);
    expect(payload.sessionLens?.byChannel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelType: 'WebChat', count: 1 }),
        expect.objectContaining({ channelType: 'Telegram', count: 1 }),
      ]),
    );
  });
});
