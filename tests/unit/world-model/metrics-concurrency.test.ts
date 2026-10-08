import { describe, expect, it, vi } from 'vitest';
import { collectWorldModelMetrics } from '@/server/world-model/metrics';
import type { WorldModelQueryExecutor } from '@/server/world-model/db';

describe('collectWorldModelMetrics', () => {
  it('starts all independent metric queries concurrently', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const query = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const pending = collectWorldModelMetrics({ query } as unknown as WorldModelQueryExecutor);

    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(7));

    for (const resolve of resolvers) {
      resolve({
        rows: [
          {
            count: '1',
            pending: '2',
            failed: '3',
            oldest_age_ms: '4',
            max_lag_ms: '5',
            total: '6',
            without_text: '7',
          },
        ],
      });
    }

    await expect(pending).resolves.toMatchObject({
      pendingObservations: 1,
      pendingProjections: 2,
      failedProjections: 3,
      deliveryReceipts: 1,
      outboxPending: 2,
      outboxFailed: 3,
      outboxAgeMs: 4,
      dueOpenLoops: 1,
      projectionLagMs: 5,
      embeddingsTotal: 6,
      embeddingsWithoutText: 7,
    });
  });
});
