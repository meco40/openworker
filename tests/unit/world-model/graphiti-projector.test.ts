import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectOutboxEvent, type ProjectionResult } from '@/server/world-model/graphiti/projector';
import { graphitiGroupId, resetGraphitiCircuit } from '@/server/world-model/graphiti/client';
import type { OutboxEvent } from '@/server/world-model/types';

function outboxEvent(partial: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'event-1',
    eventType: 'world.observation.created',
    aggregateType: 'observation',
    aggregateId: 'aggregate-1',
    userId: 'user-1',
    personaId: 'persona-1',
    workspaceId: 'workspace-1',
    payload: {},
    status: 'pending',
    attempts: 0,
    createdAt: '2026-10-08T10:00:00.000Z',
    ...partial,
  };
}

function requestsFor(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe('Graphiti projection of World Model events', () => {
  const originalBaseUrl = process.env.GRAPHITI_BASE_URL;
  const originalRetries = process.env.GRAPHITI_MAX_RETRIES;
  const originalMaxMessageChars = process.env.GRAPHITI_MAX_MESSAGE_CHARS;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GRAPHITI_BASE_URL = 'http://graphiti.test';
    process.env.GRAPHITI_MAX_RETRIES = '1';
    resetGraphitiCircuit();
    fetchMock = vi.fn<() => Promise<Response>>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalBaseUrl === undefined) delete process.env.GRAPHITI_BASE_URL;
    else process.env.GRAPHITI_BASE_URL = originalBaseUrl;
    if (originalRetries === undefined) delete process.env.GRAPHITI_MAX_RETRIES;
    else process.env.GRAPHITI_MAX_RETRIES = originalRetries;
    if (originalMaxMessageChars === undefined) delete process.env.GRAPHITI_MAX_MESSAGE_CHARS;
    else process.env.GRAPHITI_MAX_MESSAGE_CHARS = originalMaxMessageChars;
    resetGraphitiCircuit();
  });

  it('skips unsupported events, missing scope, and empty observations', async () => {
    const skipped: ProjectionResult = {
      nodesCreated: 0,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesUpdated: 0,
      skipped: 1,
    };

    await expect(projectOutboxEvent(outboxEvent({ eventType: 'world.unknown' }))).resolves.toEqual(
      skipped,
    );
    await expect(
      projectOutboxEvent(outboxEvent({ userId: '', payload: { text: 'hello' } })),
    ).resolves.toEqual(skipped);
    await expect(
      projectOutboxEvent(outboxEvent({ payload: { texts: [{ content: '  ' }, null] } })),
    ).resolves.toEqual(skipped);
    await expect(
      projectOutboxEvent(outboxEvent({ payload: { text: '', texts: 'not-an-array' } })),
    ).resolves.toEqual(skipped);
    await expect(
      projectOutboxEvent(outboxEvent({ personaId: '', payload: { text: 'hello' } })),
    ).resolves.toEqual(skipped);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses observation content and payload scope when they are present', async () => {
    await projectOutboxEvent(
      outboxEvent({
        payload: {
          userId: 'payload-user',
          personaId: 'payload-persona',
          workspaceId: 'payload-workspace',
          content: '  Direct observation content  ',
        },
      }),
    );

    const [request] = requestsFor(fetchMock, '/messages');
    const messages = request?.messages as Array<Record<string, unknown>>;
    expect(request?.group_id).toBe(
      graphitiGroupId('payload-user', 'payload-persona', 'payload-workspace'),
    );
    expect(messages[0]?.content).toBe('Direct observation content');
  });

  it('sends observation text and truncates it at the configured provider limit', async () => {
    process.env.GRAPHITI_MAX_MESSAGE_CHARS = '500';
    const source = 'x'.repeat(600);

    await expect(
      projectOutboxEvent(outboxEvent({ payload: { texts: ['invalid entry', { text: source }] } })),
    ).resolves.toEqual({
      nodesCreated: 1,
      nodesUpdated: 0,
      edgesCreated: 0,
      edgesUpdated: 0,
      skipped: 0,
    });

    const [request] = requestsFor(fetchMock, '/messages');
    expect(request?.group_id).toBe(graphitiGroupId('user-1', 'persona-1', 'workspace-1'));
    const messages = request?.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe(`${source.slice(0, 500)}\n[content truncated for Graphiti]`);
  });

  it('projects an assertion as scoped subject and object nodes with its fact metadata', async () => {
    await expect(
      projectOutboxEvent(
        outboxEvent({
          eventType: 'world.assertion.created',
          payload: {
            subject: 'Alice',
            subjectCategory: 'person',
            predicate: 'works_at',
            objectValue: 'BetaClaw',
            confidence: 0.9,
            validFrom: '2026-01-01T00:00:00.000Z',
            sourceObservationId: 'observation-1',
          },
        }),
      ),
    ).resolves.toEqual({
      nodesCreated: 2,
      nodesUpdated: 0,
      edgesCreated: 1,
      edgesUpdated: 0,
      skipped: 0,
    });

    const groupId = graphitiGroupId('user-1', 'persona-1', 'workspace-1');
    expect(requestsFor(fetchMock, '/entity-node')).toMatchObject([
      { uuid: `ent:Alice:${groupId}`, name: 'Alice' },
      { uuid: `obj:BetaClaw:${groupId}`, name: 'BetaClaw' },
    ]);
    expect(requestsFor(fetchMock, '/entity-edge')).toMatchObject([
      {
        group_id: groupId,
        name: 'works_at',
        valid_at: '2026-01-01T00:00:00.000Z',
        attributes: { confidence: 0.9, sourceObservationId: 'observation-1' },
      },
    ]);
  });

  it.each([
    {
      eventType: 'world.event.created',
      payload: {
        title: 'Kickoff',
        eventType: 'meeting',
        status: 'planned',
        scheduledFor: '2026-10-09T09:00:00.000Z',
      },
      edgeName: 'meeting',
      fact: 'Kickoff Type: meeting. Status: planned. Scheduled for: 2026-10-09T09:00:00.000Z.',
    },
    {
      eventType: 'world.relation.created',
      payload: { sourceEntity: 'Alice', targetEntity: 'Project', relationType: 'owns' },
      edgeName: 'owns',
      fact: undefined,
    },
    {
      eventType: 'world.task.status_changed',
      payload: { title: 'Review report', newStatus: 'open', dueAt: '2026-10-10' },
      edgeName: 'task',
      fact: 'Review report Status: open. Due: 2026-10-10.',
    },
  ] as const)('projects $eventType into scoped graph nodes and an edge', async (testCase) => {
    await expect(
      projectOutboxEvent(outboxEvent({ eventType: testCase.eventType, payload: testCase.payload })),
    ).resolves.toMatchObject({
      nodesCreated: 2,
      edgesCreated: 1,
      skipped: 0,
    });

    const edge = requestsFor(fetchMock, '/entity-edge')[0];
    expect(edge?.name).toBe(testCase.edgeName);
    if (testCase.fact) expect(edge?.fact).toBe(testCase.fact);
    expect(edge?.group_id).toBe(graphitiGroupId('user-1', 'persona-1', 'workspace-1'));
  });

  it.each([
    ['world.assertion.created', { subject: 'Alice', predicate: 'knows' }],
    ['world.assertion.created', { predicate: 'knows', objectValue: 'BetaClaw' }],
    ['world.assertion.created', { subject: 'Alice', objectValue: 'BetaClaw' }],
    ['world.event.created', {}],
    ['world.relation.created', { sourceEntity: 'Alice', relationType: 'knows' }],
    ['world.relation.created', { targetEntity: 'BetaClaw', relationType: 'knows' }],
    ['world.relation.created', { sourceEntity: 'Alice', targetEntity: 'BetaClaw' }],
    ['world.task.created', { taskId: 'task-1' }],
  ] as const)(
    'skips %s when its required fact fields are incomplete',
    async (eventType, payload) => {
      await expect(projectOutboxEvent(outboxEvent({ eventType, payload }))).resolves.toMatchObject({
        skipped: 1,
        nodesCreated: 0,
        edgesCreated: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('projects events and tasks with optional metadata omitted', async () => {
    await projectOutboxEvent(
      outboxEvent({
        eventType: 'world.event.created',
        payload: { title: 'Unscheduled review' },
      }),
    );
    const eventEdge = requestsFor(fetchMock, '/entity-edge')[0];
    expect(eventEdge).toMatchObject({ name: 'event', fact: 'Unscheduled review' });

    await projectOutboxEvent(
      outboxEvent({
        eventType: 'world.task.created',
        aggregateId: 'task-fallback',
        payload: { title: 'Draft task' },
      }),
    );
    const taskEdge = requestsFor(fetchMock, '/entity-edge')[1];
    expect(taskEdge).toMatchObject({ name: 'task', fact: 'Draft task' });
  });

  it('propagates a failed Graphiti write so the outbox can retry it', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      projectOutboxEvent(outboxEvent({ payload: { text: 'Alice joined the project.' } })),
    ).rejects.toThrow('HTTP 503');
  });
});
