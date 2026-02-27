import { describe, expect, it, vi } from 'vitest';
import { mockUserContext, registerOpsRouteLifecycleHooks } from './ops-routes.harness';

describe('ops routes', () => {
  registerOpsRouteLifecycleHooks();

  it('returns personas without room-runtime snapshots', async () => {
    mockUserContext({ userId: 'ops-user', authenticated: true });

    vi.doMock('../../../../src/server/personas/personaRepository', () => ({
      getPersonaRepository: () => ({
        listPersonas: () => [
          {
            id: 'persona-1',
            name: 'Nexus',
            emoji: '🤖',
            vibe: 'operator',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'general',
            updatedAt: '2026-02-20T11:00:00.000Z',
          },
          {
            id: 'persona-2',
            name: 'Atlas',
            emoji: '🛰️',
            vibe: 'analysis',
            preferredModelId: null,
            modelHubProfileId: null,
            memoryPersonaType: 'general',
            updatedAt: '2026-02-20T11:00:10.000Z',
          },
        ],
      }),
    }));

    const route = await import('../../../../app/api/ops/agents/route');
    const response = await route.GET(new Request('http://localhost/api/ops/agents?limit=0'));
    const payload = (await response.json()) as {
      ok: boolean;
      agents: {
        personas: Array<{ id: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.agents.personas).toEqual([
      expect.objectContaining({ id: 'persona-1' }),
      expect.objectContaining({ id: 'persona-2' }),
    ]);
    expect(payload.agents).not.toHaveProperty('sampledRooms');
    expect(payload.agents.personas[0]).not.toHaveProperty('activeRoomCount');
  });
});
