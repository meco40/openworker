import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetGraphitiCircuit } from '@/server/world-model/graphiti/client';
import { rebuildGraphitiFromPostgres } from '@/server/world-model/graphiti/projector';
import { closeWorldModelDb, runWorldModelMigrations } from '@/server/world-model/db';
import { deleteWorldModelScope } from '@/server/world-model/dataLifecycle';
import { projectWindow } from '@/server/world-model/projector/projectWindow';
import type { WorldModelScope } from '@/server/world-model/scope';
import type { WorldModelProjection } from '@/server/world-model/projector/types';

const enabled = process.env.WORLD_MODEL_E2E === 'true';
const createdScopes: WorldModelScope[] = [];

function newScope(scenario: string): Required<WorldModelScope> {
  const scope = {
    userId: `graphiti-projector-${scenario}-${Date.now()}`,
    personaId: 'assistant',
    workspaceId: 'coverage',
  };
  createdScopes.push(scope);
  return scope;
}

function projection(): WorldModelProjection {
  return {
    assertions: [
      {
        subject: 'Alice',
        predicate: 'works_at',
        objectValue: 'BetaClaw',
        modality: 'reported',
        confidence: 0.9,
        sourceMessageSeq: 1,
      },
    ],
    events: [
      {
        title: 'Project kickoff',
        eventType: 'meeting',
        scheduledFor: '2026-10-09T09:00:00.000Z',
        status: 'planned',
        sourceMessageSeq: 1,
      },
    ],
    entities: [
      { canonicalName: 'Alice', category: 'person', owner: 'persona', sourceMessageSeq: 1 },
      { canonicalName: 'BetaClaw', category: 'project', owner: 'shared', sourceMessageSeq: 1 },
    ],
    relations: [
      {
        sourceEntity: 'Alice',
        targetEntity: 'BetaClaw',
        relationType: 'works_at',
        confidence: 0.9,
        sourceMessageSeq: 1,
      },
    ],
    openLoops: [
      {
        type: 'clarification',
        question: 'Who owns the kickoff agenda?',
        deduplicationKey: 'kickoff-agenda',
        sourceMessageSeq: 1,
      },
    ],
    tasks: [
      { title: 'Prepare kickoff', requester: 'Alice', assignee: 'assistant', sourceMessageSeq: 1 },
      { title: 'Review notes', requester: 'Alice', assignee: 'assistant', sourceMessageSeq: 2 },
    ],
    confidenceSummary: { total: 6, confident: 5 },
  };
}

async function seedScope(scope: WorldModelScope, sourceId: string): Promise<void> {
  await projectWindow({
    scope,
    projection: projection(),
    observation: {
      ...scope,
      sourceType: 'chat_message',
      sourceId,
      occurredAt: '2026-10-08T10:00:00.000Z',
      payload: { text: 'Alice plans the project kickoff and asks for the agenda.' },
    },
    completedTaskEvidence: [
      {
        title: 'Prepare kickoff',
        messageSeq: 3,
        evidenceText: 'Alice prepared the kickoff agenda.',
        confidence: 0.95,
      },
    ],
  });
}

describe.skipIf(!enabled)('Graphiti PostgreSQL projection rebuild', () => {
  const originalBaseUrl = process.env.GRAPHITI_BASE_URL;
  const originalRetries = process.env.GRAPHITI_MAX_RETRIES;

  beforeAll(async () => {
    process.env.GRAPHITI_BASE_URL = 'http://graphiti.test';
    process.env.GRAPHITI_MAX_RETRIES = '1';
    await runWorldModelMigrations();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGraphitiCircuit();
  });

  afterAll(async () => {
    for (const scope of createdScopes) await deleteWorldModelScope(scope);
    await closeWorldModelDb();
    if (originalBaseUrl === undefined) delete process.env.GRAPHITI_BASE_URL;
    else process.env.GRAPHITI_BASE_URL = originalBaseUrl;
    if (originalRetries === undefined) delete process.env.GRAPHITI_MAX_RETRIES;
    else process.env.GRAPHITI_MAX_RETRIES = originalRetries;
  });

  it('rebuilds every canonical stage from PostgreSQL and resumes without replaying completed rows', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        requests.push({ path, body });
        return new Response(
          JSON.stringify({ pending_jobs: 0, active_jobs: 0, completed_jobs: 0, failed_jobs: 0 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const scope = newScope('complete');
    await seedScope(scope, 'all-stages');

    await expect(
      rebuildGraphitiFromPostgres({ ...scope, batchSize: 1, includeObservations: true }),
    ).resolves.toMatchObject({
      nodesCreated: 11,
      edgesCreated: 5,
      processedEvents: 6,
      byStage: { observations: 1, assertions: 1, events: 1, tasks: 2, relations: 1 },
    });

    expect(requests.filter((request) => request.path === '/messages')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/entity-edge')).toHaveLength(5);
    expect(
      requests
        .filter((request) => request.path === '/entity-node')
        .map((request) => request.body.name),
    ).toEqual(expect.arrayContaining(['Alice', 'BetaClaw', 'Project kickoff', 'Prepare kickoff']));

    const writesBeforeResume = requests.filter((request) =>
      ['/messages', '/entity-edge', '/entity-node'].includes(request.path),
    ).length;
    await expect(
      rebuildGraphitiFromPostgres({ ...scope, batchSize: 1, resume: true }),
    ).resolves.toMatchObject({
      nodesCreated: 0,
      edgesCreated: 0,
      processedEvents: 0,
      byStage: { observations: 0, assertions: 0, events: 0, tasks: 0, relations: 0 },
    });
    expect(
      requests.filter((request) =>
        ['/messages', '/entity-edge', '/entity-node'].includes(request.path),
      ),
    ).toHaveLength(writesBeforeResume);
  });

  it('retries a failed stage from its last persisted checkpoint', async () => {
    const scope = newScope('resume-after-failure');
    await seedScope(scope, 'retry-stage');
    let failFirstNode = true;
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        if (path === '/entity-node' && failFirstNode) {
          failFirstNode = false;
          return new Response('{}', { status: 503 });
        }
        return new Response(
          JSON.stringify({ pending_jobs: 0, active_jobs: 0, completed_jobs: 0, failed_jobs: 0 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(rebuildGraphitiFromPostgres({ ...scope, batchSize: 1 })).rejects.toThrow(
      'HTTP 503',
    );
    resetGraphitiCircuit();
    await expect(
      rebuildGraphitiFromPostgres({ ...scope, batchSize: 1, resume: true }),
    ).resolves.toMatchObject({
      processedEvents: 5,
      byStage: { assertions: 1, events: 1, tasks: 2, relations: 1 },
    });
    expect(requests.filter((path) => path === '/entity-node').length).toBeGreaterThan(1);
  });
});
