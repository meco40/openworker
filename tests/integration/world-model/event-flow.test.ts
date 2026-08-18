import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import {
  applyPlanChange,
  confirmEventOutcome,
  getEventHistory,
  planEvent,
} from '@/server/world-model/services/eventService';
import type { ObservationInput } from '@/server/world-model/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `event-flow-${Date.now()}`;

function chatObservation(sourceId: string, text: string, occurredAt: string): ObservationInput {
  return {
    userId: marker,
    personaId: 'p',
    workspaceId: 'w',
    sourceType: 'chat_message',
    sourceId,
    occurredAt,
    payload: { text },
  };
}

describe.skipIf(!enabled)('world-model event flow (Kino/essen reference case)', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query('DELETE FROM world_model_outbox_events WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_events WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_open_loops WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_observations WHERE user_id = $1', [marker]);
    await closeWorldModelDb();
  });

  it('keeps a cancelled plan distinct from an unconfirmed new plan', async () => {
    const { event: kino } = await planEvent({
      userId: marker,
      personaId: 'p',
      title: 'Kino',
      eventType: 'activity',
      scheduledFor: '2026-08-18T17:00:00.000Z',
      endsAt: '2026-08-18T19:00:00.000Z',
      observation: chatObservation(
        'c1',
        'Ich gehe um 17 Uhr ins Kino.',
        '2026-08-18T16:00:00.000Z',
      ),
    });

    const cancelled = await applyPlanChange({
      eventId: kino.id,
      toStatus: 'cancelled',
      reason: 'user changed plan',
      observation: chatObservation(
        'c2',
        'Ich gehe doch nicht ins Kino.',
        '2026-08-18T16:30:00.000Z',
      ),
    });
    expect(cancelled.kind).toBe('cancelled');
    if (cancelled.kind === 'cancelled') expect(cancelled.event.status).toBe('cancelled');

    const { event: dinner } = await planEvent({
      userId: marker,
      personaId: 'p',
      title: 'Essen gehen',
      eventType: 'meal',
      scheduledFor: '2026-08-18T19:30:00.000Z',
      endsAt: '2026-08-18T21:00:00.000Z',
      observation: chatObservation('c3', 'Ich gehe Essen.', '2026-08-18T16:31:00.000Z'),
    });
    expect(dinner.status).toBe('planned');

    // Without explicit confirmation, dinner must NOT become completed.
    const timeline = await getEventHistory(dinner.id);
    expect(timeline.map((t) => t.toStatus)).not.toContain('completed');

    const confirmed = await confirmEventOutcome({
      eventId: dinner.id,
      outcome: 'completed',
      observation: chatObservation('c4', 'Ja, ich war essen.', '2026-08-18T21:30:00.000Z'),
    });
    expect(confirmed.kind).toBe('completed');
    if (confirmed.kind === 'completed') expect(confirmed.event.status).toBe('completed');
  });
});
