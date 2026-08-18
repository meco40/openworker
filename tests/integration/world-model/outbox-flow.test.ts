import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import {
  claimPendingOutboxEvents,
  enqueueOutboxEvent,
  markOutboxDispatched,
  markOutboxFailed,
} from '@/server/world-model/repositories/outboxRepository';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `outbox-contract-${Date.now()}`;

describe.skipIf(!enabled)('world-model transactional outbox', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query('DELETE FROM world_model_outbox_events WHERE aggregate_id LIKE $1', [
      `${marker}%`,
    ]);
    await closeWorldModelDb();
  });

  it('claims each event once and retries failed events after backoff', async () => {
    const event = await enqueueOutboxEvent({
      eventType: 'world-model.test',
      aggregateType: 'test',
      aggregateId: `${marker}-retry`,
      payload: { marker },
    });

    const firstClaim = await claimPendingOutboxEvents(10, 'worker-a', 60_000, ['world-model.test']);
    expect(firstClaim.map((claimed) => claimed.id)).toContain(event.id);
    expect(await claimPendingOutboxEvents(10, 'worker-b', 60_000, ['world-model.test'])).toEqual(
      [],
    );

    await markOutboxFailed(event.id, 'temporary failure', 'worker-a');
    const db = getWorldModelDb();
    await db.query('UPDATE world_model_outbox_events SET next_attempt_at = now() WHERE id = $1', [
      event.id,
    ]);
    const retryClaim = await claimPendingOutboxEvents(10, 'worker-b', 60_000, ['world-model.test']);
    expect(retryClaim.map((claimed) => claimed.id)).toContain(event.id);

    await markOutboxDispatched(event.id, 'worker-b');
    expect(await claimPendingOutboxEvents(10, 'worker-c', 60_000, ['world-model.test'])).toEqual(
      [],
    );
  });
});
