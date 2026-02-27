import { describe, expect, it, vi } from 'vitest';
import { mockUserContext, registerOpsRouteLifecycleHooks } from './ops-routes.harness';

describe('ops routes', () => {
  registerOpsRouteLifecycleHooks();

  it('returns conversation sessions filtered by query and bounded by clamped limit', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    const listConversations = vi.fn().mockReturnValue([
      {
        id: 'conv-1',
        channelType: 'WebChat',
        externalChatId: 'default',
        userId: 'ops-user',
        title: 'Ops Daily',
        modelOverride: null,
        personaId: 'persona-1',
        createdAt: '2026-02-20T00:00:00.000Z',
        updatedAt: '2026-02-20T00:01:00.000Z',
      },
      {
        id: 'conv-2',
        channelType: 'Telegram',
        externalChatId: 'chat-22',
        userId: 'ops-user',
        title: 'Personal Notes',
        modelOverride: null,
        personaId: 'persona-2',
        createdAt: '2026-02-20T00:02:00.000Z',
        updatedAt: '2026-02-20T00:03:00.000Z',
      },
      {
        id: 'conv-3',
        channelType: 'Slack',
        externalChatId: 'ops-incident-room',
        userId: 'ops-user',
        title: 'Incident Room',
        modelOverride: null,
        personaId: null,
        createdAt: '2026-02-20T00:04:00.000Z',
        updatedAt: '2026-02-20T00:05:00.000Z',
      },
    ]);

    vi.doMock('../../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        listConversations,
      }),
    }));

    const route = await import('../../../../app/api/ops/sessions/route');
    const response = await route.GET(
      new Request('http://localhost/api/ops/sessions?limit=9999&q=ops'),
    );
    const payload = (await response.json()) as {
      ok: boolean;
      query: {
        q: string;
        limit: number;
        activeMinutes: number | null;
        includeGlobalRequested: boolean;
        includeGlobalApplied: boolean;
        includeUnknown: boolean;
      };
      sessions: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(listConversations).toHaveBeenCalledWith('ops-user', 200);
    expect(payload.query).toEqual({
      q: 'ops',
      limit: 200,
      activeMinutes: null,
      includeGlobalRequested: false,
      includeGlobalApplied: false,
      includeUnknown: true,
    });
    expect(payload.sessions.map((session) => session.id)).toEqual(['conv-3', 'conv-1']);
  });

  it('applies sessions advanced filters and global merge in unauthenticated legacy mode', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: false });

    const now = Date.now();
    const freshIso = new Date(now - 5 * 60_000).toISOString();
    const staleIso = new Date(now - 3 * 60 * 60_000).toISOString();

    const listConversations = vi.fn((userId?: string, limit?: number) => {
      const own = [
        {
          id: 'conv-1',
          channelType: 'WebChat',
          externalChatId: 'default',
          userId: 'ops-user',
          title: 'Ops Personal',
          modelOverride: null,
          personaId: 'persona-1',
          createdAt: freshIso,
          updatedAt: freshIso,
        },
        {
          id: 'conv-2',
          channelType: 'Slack',
          externalChatId: 'incident',
          userId: 'ops-user',
          title: 'Old Incident',
          modelOverride: null,
          personaId: 'persona-2',
          createdAt: staleIso,
          updatedAt: staleIso,
        },
        {
          id: 'conv-3',
          channelType: 'Telegram',
          externalChatId: 'chat-3',
          userId: 'ops-user',
          title: 'Unknown Persona',
          modelOverride: null,
          personaId: null,
          createdAt: freshIso,
          updatedAt: freshIso,
        },
      ];

      const global = [
        {
          id: 'conv-4',
          channelType: 'Discord',
          externalChatId: 'global-1',
          userId: 'other-user',
          title: 'Global Ops',
          modelOverride: null,
          personaId: 'persona-9',
          createdAt: freshIso,
          updatedAt: freshIso,
        },
        own[0],
      ];

      const rows = userId ? own : global;
      if (typeof limit === 'number') {
        return rows.slice(0, limit);
      }
      return rows;
    });

    vi.doMock('../../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({
        listConversations,
      }),
    }));

    const route = await import('../../../../app/api/ops/sessions/route');
    const response = await route.GET(
      new Request(
        'http://localhost/api/ops/sessions?limit=200&activeMinutes=60&includeUnknown=0&includeGlobal=1',
      ),
    );

    const payload = (await response.json()) as {
      ok: boolean;
      query: {
        q: string;
        limit: number;
        activeMinutes: number | null;
        includeGlobalRequested: boolean;
        includeGlobalApplied: boolean;
        includeUnknown: boolean;
      };
      sessions: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.query).toEqual({
      q: '',
      limit: 200,
      activeMinutes: 60,
      includeGlobalRequested: true,
      includeGlobalApplied: true,
      includeUnknown: false,
    });
    expect(listConversations).toHaveBeenCalledWith('ops-user', 200);
    expect(listConversations).toHaveBeenCalledWith(undefined, 200);
    expect(payload.sessions.map((session) => session.id)).toEqual(['conv-1', 'conv-4']);
  });
});
