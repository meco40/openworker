import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addGraphitiMessages,
  checkGraphitiHealth,
  clearGraphitiScope,
  getGraphitiQueueStatus,
  graphitiGroupId,
  resetGraphitiCircuit,
  searchGraphitiFacts,
  upsertGraphitiEdges,
  upsertGraphitiNodes,
} from '@/server/world-model/graphiti/client';

describe('world-model Graphiti REST client', () => {
  const originalBaseUrl = process.env.GRAPHITI_BASE_URL;
  const originalMaxRetries = process.env.GRAPHITI_MAX_RETRIES;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GRAPHITI_BASE_URL = 'http://graphiti.test';
    process.env.GRAPHITI_MAX_RETRIES = '1';
    resetGraphitiCircuit();
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetGraphitiCircuit();
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.GRAPHITI_BASE_URL;
    else process.env.GRAPHITI_BASE_URL = originalBaseUrl;
    if (originalMaxRetries === undefined) delete process.env.GRAPHITI_MAX_RETRIES;
    else process.env.GRAPHITI_MAX_RETRIES = originalMaxRetries;
  });

  it('uses the official healthcheck endpoint', async () => {
    await expect(checkGraphitiHealth()).resolves.toMatchObject({ reachable: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://graphiti.test/healthcheck',
      expect.objectContaining({
        headers: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('ingests messages with the Graphiti group contract', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 202 }));

    await expect(
      addGraphitiMessages('u:p:w', [
        {
          uuid: 'message-1',
          name: 'observation',
          content: 'User goes to the cinema.',
          roleType: 'system',
          timestamp: '2026-08-19T10:00:00.000Z',
          sourceDescription: 'World Model',
        },
      ]),
    ).resolves.toEqual({ accepted: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://graphiti.test/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          group_id: 'u:p:w',
          messages: [
            {
              uuid: 'message-1',
              name: 'observation',
              content: 'User goes to the cinema.',
              role_type: 'system',
              role: null,
              timestamp: '2026-08-19T10:00:00.000Z',
              source_description: 'World Model',
            },
          ],
        }),
      }),
    );
  });

  it('searches facts using the official endpoint and a safe deterministic group id', async () => {
    const groupId = graphitiGroupId('u', 'p', 'w');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ facts: [{ uuid: 'fact-1', fact: 'User goes to the cinema.' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(searchGraphitiFacts(groupId, 'cinema')).resolves.toEqual([
      { uuid: 'fact-1', fact: 'User goes to the cinema.' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://graphiti.test/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ group_ids: [groupId], query: 'cinema', max_facts: 10 }),
      }),
    );
  });

  it('reads the patched queue status contract', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pending_jobs: 2,
          active_jobs: 1,
          completed_jobs: 9,
          failed_jobs: 0,
          workers: 4,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(getGraphitiQueueStatus()).resolves.toEqual({
      pendingJobs: 2,
      activeJobs: 1,
      completedJobs: 9,
      failedJobs: 0,
      workers: 4,
    });
  });

  it('maps node, relation, and scope operations to supported endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await upsertGraphitiNodes([
      {
        id: 'node-1',
        label: 'person',
        properties: { segment: graphitiGroupId('u', 'p', 'w'), summary: 'A person' },
      },
    ]);
    await upsertGraphitiEdges([
      {
        source: 'node-1',
        target: 'node-2',
        type: 'knows',
        properties: { segment: graphitiGroupId('u', 'p', 'w') },
      },
    ]);
    await clearGraphitiScope('u', 'p', 'w');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://graphiti.test/entity-node',
      'http://graphiti.test/messages',
      `http://graphiti.test/group/${encodeURIComponent(graphitiGroupId('u', 'p', 'w'))}`,
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          uuid: 'node-1',
          group_id: graphitiGroupId('u', 'p', 'w'),
          name: 'person',
          summary: 'A person',
        }),
      }),
    );
    const edgeRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const edgeBody = JSON.parse(String(edgeRequest.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(edgeBody.messages[0]?.content).toContain('"node-1" has relation "knows" to "node-2"');
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });
});
