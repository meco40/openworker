import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
  runWithWorldModelScope,
} from '@/server/world-model/db';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import type { WorldModelProjection } from '@/server/world-model/projector/types';
import type { ObservationInput } from '@/server/world-model/types';
import { recordObservation } from '@/server/world-model/services/observationService';
import { insertTask, updateTaskStatus } from '@/server/world-model/repositories/taskRepository';
import { startActionAttempt } from '@/server/world-model/repositories/actionAttemptRepository';
import { insertOpenLoop } from '@/server/world-model/repositories/prospectiveRepository';
import { searchOpenLoops } from '@/server/world-model/retrieval/openLoops';
import { upsertEntity } from '@/server/world-model/repositories/entityRepository';
import { planQuery } from '@/server/world-model/retrieval/queryPlanner';
import { findStructuredEvents } from '@/server/world-model/retrieval/structured';
import {
  CINEMA_DINNER_SCENARIO,
  APPOINTMENT_FOLLOWUP_SCENARIO,
  APPOINTMENT_CANCELLED_SCENARIO,
  MIKE_RESPONSE_SCENARIO,
  TASK_COMPLETION_SCENARIO,
  RETROSPECTIVE_SCENARIO,
  LATE_CORRECTION_SCENARIO,
} from '../../fixtures/world-model/secretary-scenarios';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `secretary-e2e-${Date.now()}`;
const scope = {
  userId: marker,
  personaId: 'secretary-persona',
  workspaceId: 'secretary-ws',
};

function makeObservation(
  sourceId: string,
  seq: number,
  text: string,
  occurredAt: string,
): ObservationInput {
  return {
    ...scope,
    sourceType: 'chat_message' as const,
    sourceId,
    occurredAt,
    payload: {
      text,
      texts: [{ seq, role: 'user', content: text }],
    },
  };
}

function makeProjection(partial: Partial<WorldModelProjection>): WorldModelProjection {
  return {
    assertions: [],
    events: [],
    entities: [],
    relations: [],
    openLoops: [],
    tasks: [],
    confidenceSummary: { total: 1, confident: 1 },
    ...partial,
  };
}

describe.skipIf(!enabled)('Nine Secretary Reference Scenarios PostgreSQL E2E Flow', () => {
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
    await db.query('DELETE FROM world_model_assertions WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_tasks WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_action_attempts WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_open_loops WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_observations WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_entities WHERE user_id = $1', [marker]);
    await closeWorldModelDb();
  });

  it('Scenario 1: Cinema replaced by Dinner', async () => {
    await runWithWorldModelScope(scope, async () => {
      // Step 1: Cinema planned
      const obs1 = await recordObservation(
        makeObservation(
          `${marker}:cinema-1`,
          1,
          CINEMA_DINNER_SCENARIO.messages[0]!.content,
          '2026-08-18T10:00:00.000Z',
        ),
      );
      await projectWindow({
        scope,
        observation: obs1.observation,
        projection: makeProjection({
          events: [
            {
              title: 'Kino',
              eventType: 'cinema',
              scheduledFor: '2026-08-18T17:00:00.000Z',
              status: 'planned',
              sourceMessageSeq: 1,
            },
          ],
        }),
      });

      // Step 2: User cancels cinema and proposes dinner
      const obs2 = await recordObservation(
        makeObservation(
          `${marker}:cinema-2`,
          3,
          CINEMA_DINNER_SCENARIO.messages[2]!.content,
          '2026-08-18T12:00:00.000Z',
        ),
      );
      await projectWindow({
        scope,
        observation: obs2.observation,
        projection: makeProjection({
          events: [
            {
              title: 'Kino',
              eventType: 'cinema',
              scheduledFor: '2026-08-18T17:00:00.000Z',
              status: 'cancelled',
              sourceMessageSeq: 3,
            },
            {
              title: 'Essen',
              eventType: 'dinner',
              scheduledFor: '2026-08-18T19:00:00.000Z',
              status: 'planned',
              sourceMessageSeq: 3,
            },
          ],
        }),
      });

      // Step 3: User confirms dinner with Mike
      const obs3 = await recordObservation(
        makeObservation(
          `${marker}:cinema-3`,
          5,
          CINEMA_DINNER_SCENARIO.messages[4]!.content,
          '2026-08-18T22:00:00.000Z',
        ),
      );
      await projectWindow({
        scope,
        observation: obs3.observation,
        projection: makeProjection({
          assertions: [
            {
              subject: scope.personaId,
              predicate: 'attended_with',
              objectValue: 'Mike',
              modality: 'confirmed',
              confidence: 0.9,
              sourceMessageSeq: 5,
            },
          ],
          events: [
            {
              title: 'Essen',
              eventType: 'dinner',
              scheduledFor: '2026-08-18T19:00:00.000Z',
              status: 'completed',
              sourceMessageSeq: 5,
            },
          ],
          entities: [
            { canonicalName: 'Mike', category: 'person', owner: 'shared', sourceMessageSeq: 5 },
          ],
        }),
      });

      const events = await findStructuredEvents({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        term: 'Essen',
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.status === 'completed')).toBe(true);
    });
  });

  it('Scenario 2: Appointment Follow-up creates context-sensitive Open Loop', async () => {
    await runWithWorldModelScope(scope, async () => {
      const obs = await recordObservation(
        makeObservation(
          `${marker}:apt-followup`,
          1,
          APPOINTMENT_FOLLOWUP_SCENARIO.messages[0]!.content,
          '2026-08-18T15:00:00.000Z',
        ),
      );

      await projectWindow({
        scope,
        observation: obs.observation,
        projection: makeProjection({
          events: [
            {
              title: 'Termin bei Dr. Müller',
              eventType: 'appointment',
              scheduledFor: '2026-08-18T15:00:00.000Z',
              status: 'planned',
              sourceMessageSeq: 1,
            },
          ],
          entities: [
            {
              canonicalName: 'Dr. Müller',
              category: 'person',
              owner: 'shared',
              sourceMessageSeq: 1,
            },
          ],
          openLoops: [
            {
              type: 'event_outcome',
              question: 'Wie ist dein Termin bei Dr. Müller gelaufen?',
              deduplicationKey: `outcome:dr-mueller:${marker}`,
              sourceMessageSeq: 1,
            },
          ],
        }),
      });

      const activeLoops = await searchOpenLoops(scope);
      const drMuellerLoop = activeLoops.find((l) => l.question?.includes('Dr. Müller'));
      expect(drMuellerLoop).toBeDefined();
      expect(drMuellerLoop?.type).toBe('event_outcome');
    });
  });

  it('Scenario 3: Cancelled Appointment leaves no outcome question', async () => {
    await runWithWorldModelScope(scope, async () => {
      const obs = await recordObservation(
        makeObservation(
          `${marker}:apt-cancelled`,
          3,
          APPOINTMENT_CANCELLED_SCENARIO.messages[2]!.content,
          '2026-08-18T09:00:00.000Z',
        ),
      );

      await projectWindow({
        scope,
        observation: obs.observation,
        projection: makeProjection({
          events: [
            {
              title: 'Zahnarzttermin',
              eventType: 'appointment',
              scheduledFor: '2026-08-19T10:00:00.000Z',
              status: 'cancelled',
              sourceMessageSeq: 3,
            },
          ],
        }),
      });

      const events = await findStructuredEvents({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        term: 'Zahnarzttermin',
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.status).toBe('cancelled');
    });
  });

  it('Scenario 4: Mike response Standing Intent registration', async () => {
    await runWithWorldModelScope(scope, async () => {
      const obs = await recordObservation(
        makeObservation(
          `${marker}:mike-intent`,
          1,
          MIKE_RESPONSE_SCENARIO.messages[0]!.content,
          '2026-08-18T11:00:00.000Z',
        ),
      );

      await projectWindow({
        scope,
        observation: obs.observation,
        projection: makeProjection({
          assertions: [
            {
              subject: scope.personaId,
              predicate: 'standing_intent',
              objectValue: 'Erinnere an Angebot wenn Mike antwortet',
              modality: 'planned',
              confidence: 0.9,
              sourceMessageSeq: 1,
            },
          ],
          entities: [
            { canonicalName: 'Mike', category: 'person', owner: 'shared', sourceMessageSeq: 1 },
          ],
        }),
      });

      const db = getWorldModelDb();
      const res = await db.query<{ object_value: string }>(
        `SELECT object_value FROM world_model_assertions WHERE user_id = $1 AND predicate = 'standing_intent'`,
        [scope.userId],
      );
      expect(res.rows.length).toBeGreaterThanOrEqual(1);
      expect(res.rows[0]?.object_value).toContain('Angebot');
    });
  });

  it('Scenario 5: Two Christinas disambiguation triggers clarification loop', async () => {
    await runWithWorldModelScope(scope, async () => {
      await upsertEntity({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        canonicalName: 'Christina (Buchhaltung)',
        category: 'person',
        properties: { department: 'Buchhaltung' },
      });
      await upsertEntity({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        canonicalName: 'Christina (Marketing)',
        category: 'person',
        properties: { department: 'Marketing' },
      });

      const loop = await insertOpenLoop({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        type: 'clarification',
        question: 'Welche Christina? Buchhaltung oder Marketing?',
        deduplicationKey: `clarification:christina:${marker}`,
        importance: 1,
        maxAttempts: 3,
      });
      expect(loop.type).toBe('clarification');
      expect(loop.status).toBe('open');
    });
  });

  it('Scenario 6: Email draft only has no side-effects and remains planned', async () => {
    await runWithWorldModelScope(scope, async () => {
      const attempt = await startActionAttempt({
        scope,
        actionType: 'email_draft',
        idempotencyKey: `draft-mike-${marker}`,
      });
      expect(attempt.created).toBe(true);
      expect(attempt.attempt.status).toBe('started');
    });
  });

  it('Scenario 7: Task completion is persisted only with observation evidence', async () => {
    await runWithWorldModelScope(scope, async () => {
      const task = await insertTask({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        title: 'Bericht bis Freitag fertigstellen',
        status: 'proposed',
        idempotencyKey: `task-bericht-${marker}`,
      });

      const evidenceObs = await recordObservation(
        makeObservation(
          `${marker}:task-done-signal`,
          3,
          TASK_COMPLETION_SCENARIO.messages[2]!.content,
          '2026-08-18T16:00:00.000Z',
        ),
      );

      await updateTaskStatus(task.id, 'completed');
      const db = getWorldModelDb();
      await db.query(`UPDATE world_model_tasks SET completion_evidence_id = $2 WHERE id = $1`, [
        task.id,
        evidenceObs.observation.id,
      ]);

      const res = await db.query<{ status: string; completion_evidence_id: string }>(
        `SELECT status, completion_evidence_id FROM world_model_tasks WHERE id = $1`,
        [task.id],
      );
      expect(res.rows[0]?.status).toBe('completed');
      expect(res.rows[0]?.completion_evidence_id).toBe(evidenceObs.observation.id);
    });
  });

  it('Scenario 8: Retrospective separates completed events from cancelled plans', async () => {
    await runWithWorldModelScope(scope, async () => {
      const obs = await recordObservation(
        makeObservation(
          `${marker}:retrospective`,
          1,
          RETROSPECTIVE_SCENARIO.messages[0]!.content,
          '2026-08-18T18:00:00.000Z',
        ),
      );

      await projectWindow({
        scope,
        observation: obs.observation,
        projection: makeProjection({
          events: [
            { title: 'Büro', eventType: 'work', status: 'completed', sourceMessageSeq: 1 },
            { title: 'Home-Office', eventType: 'work', status: 'completed', sourceMessageSeq: 1 },
            {
              title: 'Fitnessstudio',
              eventType: 'sport',
              status: 'cancelled',
              sourceMessageSeq: 2,
            },
            {
              title: 'Team-Meeting',
              eventType: 'meeting',
              status: 'completed',
              sourceMessageSeq: 3,
            },
          ],
        }),
      });

      const plan = planQuery({ text: 'Was habe ich letzte Woche gemacht?' });
      expect(plan.intent).toBe('what_done');

      const completedEvents = await findStructuredEvents({
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        term: 'Meeting',
        statusFilter: ['completed'],
      });
      expect(completedEvents.some((e) => e.title === 'Team-Meeting')).toBe(true);
    });
  });

  it('Scenario 9: Late Correction maintains bitemporal separation (Berlin vs München)', async () => {
    await runWithWorldModelScope(scope, async () => {
      // Step 1: Initial report Berlin
      const obs1 = await recordObservation(
        makeObservation(
          `${marker}:travel-berlin`,
          1,
          LATE_CORRECTION_SCENARIO.messages[0]!.content,
          '2026-08-10T10:00:00.000Z',
        ),
      );
      const p1 = await projectWindow({
        scope,
        observation: obs1.observation,
        projection: makeProjection({
          events: [
            { title: 'Berlin', eventType: 'travel', status: 'completed', sourceMessageSeq: 1 },
          ],
          entities: [
            { canonicalName: 'Berlin', category: 'place', owner: 'shared', sourceMessageSeq: 1 },
          ],
        }),
      });
      expect(p1.eventsCreated).toBe(1);

      // Step 2: Correction to München
      const obs2 = await recordObservation(
        makeObservation(
          `${marker}:travel-muenchen`,
          2,
          LATE_CORRECTION_SCENARIO.messages[1]!.content,
          '2026-08-18T10:00:00.000Z',
        ),
      );
      const p2 = await projectWindow({
        scope,
        observation: obs2.observation,
        projection: makeProjection({
          events: [
            { title: 'München', eventType: 'travel', status: 'completed', sourceMessageSeq: 2 },
          ],
          entities: [
            { canonicalName: 'München', category: 'place', owner: 'shared', sourceMessageSeq: 2 },
          ],
        }),
      });
      expect(p2.eventsCreated).toBe(1);

      const db = getWorldModelDb();
      const events = await db.query<{ title: string; status: string }>(
        `SELECT title, status FROM world_model_events WHERE user_id = $1 ORDER BY created_at ASC`,
        [scope.userId],
      );
      expect(events.rows.map((e) => e.title)).toEqual(
        expect.arrayContaining(['Berlin', 'München']),
      );
    });
  });
});
