import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getWorldModelConfig: vi.fn<MockProcedure>(),
  getWorldModelDb: vi.fn<MockProcedure>(),
  query: vi.fn<MockProcedure>(),
  checkGraphitiHealth: vi.fn<MockProcedure>(),
}));

vi.mock('@/server/world-model/config', () => ({ getWorldModelConfig: mocks.getWorldModelConfig }));
vi.mock('@/server/world-model/db', () => ({ getWorldModelDb: mocks.getWorldModelDb }));
vi.mock('@/server/world-model/graphiti/client', () => ({
  checkGraphitiHealth: mocks.checkGraphitiHealth,
}));

import {
  collectWorldModelMetrics,
  evaluateWorldModelAlerts,
  getWorldModelMetrics,
  summarizeWorldModelMetrics,
} from '@/server/world-model/metrics';
import type { MockProcedure } from '../../helpers/mockProcedure';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorldModelConfig.mockReturnValue({ mode: 'shadow', graphitiShadowEnabled: false });
  mocks.getWorldModelDb.mockReturnValue({ query: mocks.query });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.checkGraphitiHealth.mockResolvedValue({ reachable: true });
});

afterEach(() => vi.restoreAllMocks());

describe('collectWorldModelMetrics', () => {
  it('defaults missing aggregate rows to zero', async () => {
    await expect(collectWorldModelMetrics()).resolves.toEqual({
      pendingObservations: 0,
      outboxPending: 0,
      outboxFailed: 0,
      outboxAgeMs: 0,
      dueOpenLoops: 0,
      projectionLagMs: 0,
      embeddingsTotal: 0,
      embeddingsWithoutText: 0,
      pendingProjections: 0,
      failedProjections: 0,
      deliveryReceipts: 0,
    });
    expect(mocks.query).toHaveBeenCalledTimes(7);
  });

  it('isolates failures from every independent metric query', async () => {
    const error = new Error('database unavailable');
    mocks.query.mockRejectedValue(error);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(collectWorldModelMetrics()).resolves.toMatchObject({
      pendingObservations: 0,
      outboxPending: 0,
      outboxFailed: 0,
      outboxAgeMs: 0,
      dueOpenLoops: 0,
      projectionLagMs: 0,
      embeddingsTotal: 0,
      embeddingsWithoutText: 0,
      pendingProjections: 0,
      failedProjections: 0,
      deliveryReceipts: 0,
    });
    expect(console.error).toHaveBeenCalledTimes(7);
  });
});

describe('getWorldModelMetrics', () => {
  it('adds Graphiti health only when shadow checks are enabled and reports failures', async () => {
    const disabled = await getWorldModelMetrics();
    expect(disabled).toMatchObject({ mode: 'shadow' });
    expect(disabled).not.toHaveProperty('graphitiReachable');
    expect(mocks.checkGraphitiHealth).not.toHaveBeenCalled();

    mocks.getWorldModelConfig.mockReturnValue({ mode: 'shadow', graphitiShadowEnabled: true });
    await expect(getWorldModelMetrics()).resolves.toMatchObject({ graphitiReachable: true });

    mocks.checkGraphitiHealth.mockRejectedValueOnce(new Error('Graphiti unavailable'));
    await expect(getWorldModelMetrics()).resolves.toMatchObject({ graphitiReachable: false });
  });
});

describe('evaluateWorldModelAlerts', () => {
  it('emits every alert above its default threshold and none at the boundary', () => {
    const breached = summarizeWorldModelMetrics(
      {
        pendingObservations: 51,
        outboxAgeMs: 5 * 60_000 + 1,
        outboxDeadLetters: 11,
        dueOpenLoops: 0,
        projectionLagMs: 5 * 60_000 + 1,
      },
      'canonical',
    );
    breached.pendingProjections = 51;
    breached.failedProjections = 1;
    expect(evaluateWorldModelAlerts(breached).map(({ rule }) => rule)).toEqual([
      'outbox_age',
      'outbox_dead_letters',
      'pending_observations',
      'pending_projections',
      'failed_projections',
      'projection_lag',
    ]);

    const atBoundary = summarizeWorldModelMetrics(
      {
        pendingObservations: 50,
        outboxAgeMs: 5 * 60_000,
        outboxDeadLetters: 10,
        dueOpenLoops: 0,
        projectionLagMs: 5 * 60_000,
      },
      'canonical',
    );
    atBoundary.pendingProjections = 50;
    expect(evaluateWorldModelAlerts(atBoundary)).toEqual([]);
  });
});
