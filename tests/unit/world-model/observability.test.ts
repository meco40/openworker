import { describe, expect, it } from 'vitest';

import { buildScopeWhere, retentionCutoffDays } from '@/server/world-model/dataLifecycle';
import { summarizeWorldModelMetrics, worldModelHealthStatus } from '@/server/world-model/metrics';

describe('worldModelMetrics', () => {
  it('summarizes metrics and clamps negatives to zero', () => {
    const metrics = summarizeWorldModelMetrics(
      {
        pendingObservations: 5,
        outboxAgeMs: -100,
        outboxDeadLetters: 1,
        dueOpenLoops: 2,
        projectionLagMs: 3000,
      },
      'shadow',
    );
    expect(metrics.pendingObservations).toBe(5);
    expect(metrics.outboxAgeMs).toBe(0);
    expect(metrics.mode).toBe('shadow');
  });

  it('reports degraded when dead letters or old outbox', () => {
    const healthy = worldModelHealthStatus(
      summarizeWorldModelMetrics(
        {
          pendingObservations: 1,
          outboxAgeMs: 1000,
          outboxDeadLetters: 0,
          dueOpenLoops: 1,
          projectionLagMs: 0,
        },
        'shadow',
      ),
    );
    expect(healthy).toBe('healthy');
    const degraded = worldModelHealthStatus(
      summarizeWorldModelMetrics(
        {
          pendingObservations: 1,
          outboxAgeMs: 10 * 60_000,
          outboxDeadLetters: 2,
          dueOpenLoops: 1,
          projectionLagMs: 0,
        },
        'shadow',
      ),
    );
    expect(degraded).toBe('degraded');
  });
});

describe('dataLifecycle', () => {
  it('builds a scoped WHERE clause', () => {
    const { clause, values } = buildScopeWhere({ userId: 'u', personaId: 'p' });
    expect(clause).toContain('user_id = $1');
    expect(clause).toContain('persona_id = $2');
    expect(values).toEqual(['u', 'p']);
  });

  it('returns no clause when no scope given', () => {
    const { clause, values } = buildScopeWhere({});
    expect(clause).toBe('');
    expect(values).toEqual([]);
  });

  it('exposes retention cutoffs', () => {
    expect(
      retentionCutoffDays(
        {
          observationsDays: 365,
          assertionsDays: 1000,
          eventsDays: 365,
          openLoopsDays: 90,
          outboxDays: 30,
        },
        'outboxDays',
      ),
    ).toBe(30);
  });
});
