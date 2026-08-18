import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Observation, StandingIntentRecord } from '@/server/world-model/types';

let matchStandingIntents: typeof import('@/server/world-model/services/prospectiveEngine').matchStandingIntents;

const listArmed = vi.fn();
const registerFire = vi.fn();
const transactionDb = { query: vi.fn() };

vi.mock('@/server/world-model/db', () => ({
  withWorldModelTransaction: (callback: (db: typeof transactionDb) => Promise<unknown>) =>
    callback(transactionDb),
}));

vi.mock('@/server/world-model/services/standingIntentDispatcher', () => ({
  dispatchStandingIntentAction: vi.fn(async () => ({
    dispatched: true,
    outboxEventId: 'outbox-1',
    created: true,
  })),
}));

vi.mock('@/server/world-model/repositories/prospectiveRepository', () => ({
  listArmedStandingIntents: (...args: unknown[]) => listArmed(...args),
  registerStandingIntentFire: (...args: unknown[]) => registerFire(...args),
  listDueOpenLoops: vi.fn(async () => []),
  listOverdueOpenLoops: vi.fn(async () => []),
  updateOpenLoopStatus: vi.fn(async () => {}),
}));

function intent(partial: Partial<StandingIntentRecord>): StandingIntentRecord {
  return {
    id: 'i',
    userId: 'u',
    personaId: 'p',
    workspaceId: 'w',
    description: 'd',
    triggerTerms: ['mike'],
    eventType: undefined,
    subjectScope: undefined,
    channelScope: undefined,
    senderScope: undefined,
    status: 'armed',
    expiresAt: undefined,
    cooldownUntil: undefined,
    cooldownMs: 0,
    fireCount: 0,
    maxFires: 0,
    lastFiredAt: undefined,
    deduplicationKey: 'k',
    createdAt: '2026-08-18T12:00:00.000Z',
    updatedAt: '2026-08-18T12:00:00.000Z',
    ...partial,
  };
}

function observation(text: string, occurredAt = '2026-08-18T13:00:00.000Z'): Observation {
  return {
    id: 'o',
    userId: 'u',
    personaId: 'p',
    workspaceId: 'w',
    sourceType: 'chat_message',
    sourceId: 's1',
    occurredAt,
    receivedAt: occurredAt,
    payload: { text },
    sourceAuthority: 'system',
  };
}

describe('matchStandingIntents', () => {
  beforeEach(async () => {
    vi.doUnmock('@/server/world-model/services/prospectiveEngine');
    vi.resetModules();
    matchStandingIntents = (await import('@/server/world-model/services/prospectiveEngine'))
      .matchStandingIntents;
    listArmed.mockReset();
    registerFire.mockReset();
  });

  it('fires when a trigger term matches the observation payload', async () => {
    listArmed.mockResolvedValue([intent({})]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(1);
    expect(result[0]?.matched).toBe(true);
    expect(registerFire).toHaveBeenCalledWith('i', '2026-08-18T13:00:00.000Z', transactionDb);
  });

  it('respects max_fires budget', async () => {
    listArmed.mockResolvedValue([intent({ maxFires: 2, fireCount: 2 })]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(0);
    expect(registerFire).not.toHaveBeenCalled();
  });

  it('respects cooldown window', async () => {
    listArmed.mockResolvedValue([intent({ cooldownUntil: '2026-08-18T14:00:00.000Z' })]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(0);
  });

  it('respects expiry', async () => {
    listArmed.mockResolvedValue([intent({ expiresAt: '2026-08-18T12:30:00.000Z' })]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(0);
  });

  it('ignores non-armed intents', async () => {
    listArmed.mockResolvedValue([intent({ status: 'cooldown' })]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(0);
  });

  it('does not fire when no trigger term matches', async () => {
    listArmed.mockResolvedValue([intent({ triggerTerms: ['christina'] })]);
    const result = await matchStandingIntents(observation('Mike hat geantwortet'));
    expect(result).toHaveLength(0);
    expect(registerFire).not.toHaveBeenCalled();
  });
});
