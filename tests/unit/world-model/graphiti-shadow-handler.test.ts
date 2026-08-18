import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxEvent } from '@/server/world-model/types';

let shadow: typeof import('@/server/world-model/graphiti/shadow');
const query = vi.fn();

vi.mock('@/server/world-model/db', () => ({
  getWorldModelDb: () => ({ query }),
}));

function event(partial: Partial<OutboxEvent>): OutboxEvent {
  return {
    id: 'e',
    eventType: 'world.observation.created',
    aggregateType: 'observation',
    aggregateId: 'obs1',
    payload: {},
    status: 'pending',
    attempts: 0,
    createdAt: '2026-08-18T12:00:00.000Z',
    ...partial,
  };
}

describe('graphiti shadow handler (Phase 5)', () => {
  beforeEach(async () => {
    query.mockReset();
    query.mockResolvedValue({ rows: [{ count: '0' }] });
    vi.doUnmock('@/server/world-model/graphiti/shadow');
    vi.resetModules();
    shadow = await import('@/server/world-model/graphiti/shadow');
  });

  it('writes a shadow edge from an observation-created outbox event', async () => {
    const handler = shadow.createGraphitiShadowHandler();
    await handler(
      event({
        payload: { userId: 'u', personaId: 'p', text: 'Ich gehe ins Kino.', sourceEntity: 'u' },
      }),
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [, values] = query.mock.calls[0];
    expect(values).toContain('u');
    expect(values).toContain('p');
    expect(values).toContain('mentions');
    expect(values).toContain('Ich gehe ins Kino.');
  });

  it('counts shadow edges via the repository query', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const total = await shadow.countShadowEdges('u', 'p');
    expect(total).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
