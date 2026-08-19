import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import { normalizeExtraction } from '@/server/world-model/projector/normalizeExtraction';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import { CINEMA_DINNER_SCENARIO } from '../../fixtures/world-model/secretary-scenarios';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { ObservationInput } from '@/server/world-model/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `cinema-dinner-${Date.now()}`;
const scope = {
  userId: marker,
  personaId: 'assistant',
  workspaceId: 'workspace-a',
};

function observation(
  sourceId: string,
  texts: Array<{ seq: number; role: string; content: string }>,
  occurredAt: string,
): ObservationInput {
  return {
    ...scope,
    sourceType: 'chat_message' as const,
    sourceId,
    occurredAt,
    payload: { texts },
  };
}

function baseExtraction(): Omit<
  KnowledgeExtractionResult,
  'events' | 'facts' | 'teaser' | 'episode'
> {
  return {
    entities: [],
    meetingLedger: {
      topicKey: 'cinema-dinner',
      counterpart: null,
      participants: [],
      decisions: [],
      negotiatedTerms: [],
      openPoints: [],
      actionItems: [],
      sourceRefs: [],
      confidence: 0.8,
    },
  };
}

describe.skipIf(!enabled)('cinema-dinner language flow', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query('DELETE FROM world_model_outbox_events WHERE user_id = $1', [marker]);
    await db.query(
      `DELETE FROM world_model_event_transitions
       WHERE event_id IN (SELECT id FROM world_model_events WHERE user_id = $1)`,
      [marker],
    );
    await db.query('DELETE FROM world_model_events WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_open_loops WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_observations WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_entities WHERE user_id = $1', [marker]);
    await closeWorldModelDb();
  });

  it('cancels cinema and completes dinner across the scenario', async () => {
    const messages = CINEMA_DINNER_SCENARIO.messages;

    // Window 1: User plans cinema.
    const window1: KnowledgeExtractionResult = {
      ...baseExtraction(),
      facts: [],
      teaser: 'Nutzer plant Kino um 17 Uhr.',
      episode: 'Ich gehe um 17 Uhr ins Kino.',
      events: [
        {
          eventType: 'cinema',
          speakerRole: 'user',
          subject: 'Kino',
          counterpart: '',
          relationLabel: null,
          timeExpression: '17 Uhr',
          startDate: '2026-08-18T17:00:00.000Z',
          endDate: '',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [1],
        },
      ],
    };

    await projectWindow({
      scope,
      projection: normalizeExtraction({ result: window1, ...scope }),
      observation: observation(
        'c1',
        messages.map((m) => ({ seq: m.seq, role: m.role, content: m.content })),
        '2026-08-18T16:00:00.000Z',
      ),
      extraction: window1,
    });

    // Window 2: User cancels cinema and plans dinner instead.
    const window2: KnowledgeExtractionResult = {
      ...baseExtraction(),
      facts: [],
      teaser: 'Kino abgesagt, stattdessen Essen geplant.',
      episode: 'Ich gehe doch nicht ins Kino. Ich gehe Essen.',
      events: [
        {
          eventType: 'cinema',
          speakerRole: 'user',
          subject: 'Kino',
          counterpart: '',
          relationLabel: null,
          timeExpression: '',
          startDate: '',
          endDate: '',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [3],
        },
        {
          eventType: 'dinner',
          speakerRole: 'user',
          subject: 'Essen',
          counterpart: '',
          relationLabel: null,
          timeExpression: '',
          startDate: '',
          endDate: '',
          dayCount: 1,
          isConfirmation: false,
          confirmationSignals: [],
          sourceSeq: [3],
        },
      ],
    };

    await projectWindow({
      scope,
      projection: normalizeExtraction({ result: window2, ...scope }),
      observation: observation(
        'c2',
        messages.map((m) => ({ seq: m.seq, role: m.role, content: m.content })),
        '2026-08-18T16:30:00.000Z',
      ),
      extraction: window2,
    });

    // Window 3: User confirms dinner outcome.
    const window3: KnowledgeExtractionResult = {
      ...baseExtraction(),
      facts: ['Essen war mit Mike'],
      teaser: 'Essen war mit Mike.',
      episode: 'Ja, ich war essen. Es war mit Mike.',
      events: [
        {
          eventType: 'dinner',
          speakerRole: 'user',
          subject: 'Essen',
          counterpart: 'Mike',
          relationLabel: null,
          timeExpression: '',
          startDate: '',
          endDate: '',
          dayCount: 1,
          isConfirmation: true,
          confirmationSignals: ['Ja, ich war essen'],
          sourceSeq: [5],
        },
      ],
    };

    await projectWindow({
      scope,
      projection: normalizeExtraction({ result: window3, ...scope }),
      observation: observation(
        'c3',
        messages.map((m) => ({ seq: m.seq, role: m.role, content: m.content })),
        '2026-08-18T21:30:00.000Z',
      ),
      extraction: window3,
    });

    const db = getWorldModelDb();
    const events = await db.query<{ title: string; status: string }>(
      `SELECT title, status FROM world_model_events
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       ORDER BY title`,
      [scope.userId, scope.personaId, scope.workspaceId],
    );

    expect(events.rows).toHaveLength(2);
    expect(events.rows).toContainEqual({ title: 'Essen', status: 'completed' });
    expect(events.rows).toContainEqual({ title: 'Kino', status: 'cancelled' });
  });
});
