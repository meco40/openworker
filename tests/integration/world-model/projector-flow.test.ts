import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
} from '@/server/world-model/db';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import type { WorldModelProjection } from '@/server/world-model/projector/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const marker = `projector-contract-${Date.now()}`;
const scope = { userId: marker, personaId: 'assistant', workspaceId: 'workspace-a' };

describe.skipIf(!enabled)('world-model projector transaction and replay', () => {
  beforeAll(async () => {
    await runWorldModelMigrations();
  });

  afterAll(async () => {
    const db = getWorldModelDb();
    await db.query('DELETE FROM world_model_outbox_events WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_events WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_open_loops WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_observations WHERE user_id = $1', [marker]);
    await db.query('DELETE FROM world_model_entities WHERE user_id = $1', [marker]);
    await closeWorldModelDb();
  });

  it('commits assertions, relations and events once when a window is replayed', async () => {
    const projection: WorldModelProjection = {
      assertions: [
        {
          subject: 'assistant',
          predicate: 'reported_fact',
          objectValue: 'Mike ist dabei',
          modality: 'reported',
          confidence: 0.8,
          sourceMessageSeq: 1,
        },
      ],
      entities: [
        { canonicalName: 'Mike', category: 'person', owner: 'shared', sourceMessageSeq: 1 },
        { canonicalName: 'Kino', category: 'place', owner: 'shared', sourceMessageSeq: 1 },
      ],
      relations: [
        {
          sourceEntity: 'Mike',
          targetEntity: 'Kino',
          relationType: 'visits',
          confidence: 0.8,
          sourceMessageSeq: 1,
        },
      ],
      events: [
        {
          title: 'Kino',
          eventType: 'activity',
          scheduledFor: '2026-08-18T17:00:00.000Z',
          status: 'planned',
          sourceMessageSeq: 1,
        },
      ],
      openLoops: [],
      tasks: [],
      confidenceSummary: { total: 4, confident: 3 },
    };
    const observation = {
      ...scope,
      sourceType: 'chat_message' as const,
      sourceId: `${marker}:1`,
      occurredAt: '2026-08-18T16:00:00.000Z',
      payload: { text: 'Mike geht ins Kino.' },
    };

    await projectWindow({ scope, projection, observation });
    await projectWindow({ scope, projection, observation });

    const db = getWorldModelDb();
    const counts = await db.query<{
      assertions: string;
      relations: string;
      events: string;
      transitions: string;
    }>(
      `SELECT
        (SELECT count(*) FROM world_model_assertions WHERE user_id = $1) AS assertions,
        (SELECT count(*) FROM world_model_entity_relations WHERE user_id = $1) AS relations,
        (SELECT count(*) FROM world_model_events WHERE user_id = $1) AS events,
        (SELECT count(*) FROM world_model_event_transitions transition
          JOIN world_model_events event ON event.id = transition.event_id
          WHERE event.user_id = $1) AS transitions`,
      [marker],
    );
    expect(counts.rows[0]).toEqual({
      assertions: '1',
      relations: '1',
      events: '1',
      transitions: '1',
    });
  });
});
