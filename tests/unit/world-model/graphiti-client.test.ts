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
  waitForGraphitiQueue,
} from '@/server/world-model/graphiti/client';

describe('world-model Graphiti REST client', () => {
  const originalBaseUrl = process.env.GRAPHITI_BASE_URL;
  const originalMaxRetries = process.env.GRAPHITI_MAX_RETRIES;
  const originalApiKey = process.env.GRAPHITI_API_KEY;
  const originalTimeout = process.env.GRAPHITI_TIMEOUT_MS;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GRAPHITI_BASE_URL = 'http://graphiti.test';
    process.env.GRAPHITI_MAX_RETRIES = '1';
    delete process.env.GRAPHITI_API_KEY;
    delete process.env.GRAPHITI_TIMEOUT_MS;
    resetGraphitiCircuit();
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetGraphitiCircuit();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.GRAPHITI_BASE_URL;
    else process.env.GRAPHITI_BASE_URL = originalBaseUrl;
    if (originalMaxRetries === undefined) delete process.env.GRAPHITI_MAX_RETRIES;
    else process.env.GRAPHITI_MAX_RETRIES = originalMaxRetries;
    if (originalApiKey === undefined) delete process.env.GRAPHITI_API_KEY;
    else process.env.GRAPHITI_API_KEY = originalApiKey;
    if (originalTimeout === undefined) delete process.env.GRAPHITI_TIMEOUT_MS;
    else process.env.GRAPHITI_TIMEOUT_MS = originalTimeout;
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
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
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
      'http://graphiti.test/entity-edge',
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
      source_node_uuid: string;
      target_node_uuid: string;
      fact: string;
    };
    expect(edgeBody).toMatchObject({
      source_node_uuid: 'node-1',
      target_node_uuid: 'node-2',
    });
    expect(edgeBody.fact).toContain('"node-1" has relation "knows" to "node-2"');
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });

  it('returns early for empty message searches and deduplicates with Graphiti defaults', async () => {
    await expect(addGraphitiMessages('', [{ content: 'ignored' }])).resolves.toEqual({
      accepted: 0,
    });
    await expect(addGraphitiMessages('group', [])).resolves.toEqual({ accepted: 0 });
    await expect(searchGraphitiFacts('', 'query')).resolves.toEqual([]);
    await expect(searchGraphitiFacts('group', '   ')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      addGraphitiMessages('group', [
        { name: 'observation', content: 'same content', timestamp: '2026-10-08T10:00:00Z' },
        { name: 'observation', content: 'same content', timestamp: '2026-10-08T10:00:00Z' },
        { uuid: 'unique-id', content: 'unique content' },
        { uuid: 'unique-id', content: 'duplicate uuid' },
      ]),
    ).resolves.toEqual({ accepted: 2 });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      name: 'observation',
      role_type: 'system',
      role: null,
      source_description: 'BetaClaw World Model',
    });
    expect(new Date(String(body.messages[0]?.timestamp)).toISOString()).toBe(
      '2026-10-08T10:00:00.000Z',
    );
    expect(body.messages[1]).toMatchObject({ uuid: 'unique-id', role_type: 'system' });
  });

  it('parses fact arrays defensively and clamps the requested fact count', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          null,
          false,
          { fact: '   ' },
          {
            uuid: 'fact-1',
            name: 'relation',
            fact: '  trimmed fact  ',
            valid_at: 'from',
            invalid_at: 'until',
            source_node_uuid: 'source-1',
            target_node_uuid: 'target-1',
          },
          { uuid: 2, name: null, fact: 'minimal', valid_at: 3 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(searchGraphitiFacts('group', 'query', 1000)).resolves.toEqual([
      {
        uuid: 'fact-1',
        name: 'relation',
        fact: 'trimmed fact',
        validAt: 'from',
        invalidAt: 'until',
        sourceNodeUuid: 'source-1',
        targetNodeUuid: 'target-1',
      },
      {
        uuid: undefined,
        name: undefined,
        fact: 'minimal',
        validAt: undefined,
        invalidAt: undefined,
        sourceNodeUuid: undefined,
        targetNodeUuid: undefined,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ group_ids: ['group'], query: 'query', max_facts: 100 }),
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ facts: 'invalid' }), { status: 200 }),
    );
    await expect(searchGraphitiFacts('group', 'query', -4)).resolves.toEqual([]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ group_ids: ['group'], query: 'query', max_facts: 1 }),
    });
  });

  it('sends the API key and strips trailing slashes from the configured base URL', async () => {
    process.env.GRAPHITI_BASE_URL = 'http://graphiti.test///';
    process.env.GRAPHITI_API_KEY = 'local-test-key';

    await expect(checkGraphitiHealth()).resolves.toMatchObject({ reachable: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://graphiti.test/healthcheck');
    expect(headers.get('authorization')).toBe('Bearer local-test-key');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('retries a transient request once and resets the breaker after success', async () => {
    process.env.GRAPHITI_MAX_RETRIES = '2';
    fetchMock
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await expect(addGraphitiMessages('group', [{ content: 'retry me' }])).resolves.toEqual({
      accepted: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(checkGraphitiHealth()).resolves.toMatchObject({ reachable: true });
  });

  it('opens the circuit after failed requests and resets it after the cooldown', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 503, statusText: 'Busy' }));

    await expect(addGraphitiMessages('group', [{ content: 'fail me' }])).rejects.toThrow(
      /HTTP 503 Busy/,
    );
    await expect(checkGraphitiHealth()).resolves.toMatchObject({
      reachable: false,
      error: expect.stringContaining('circuit breaker open'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[world-model:graphiti] circuit breaker tripped');

    clock.mockImplementation(() => now + 60_001);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(checkGraphitiHealth()).resolves.toMatchObject({ reachable: true });
    expect(info).toHaveBeenCalledWith('[world-model:graphiti] circuit breaker reset');
  });

  it('converts aborts into a clear timeout error', async () => {
    process.env.GRAPHITI_TIMEOUT_MS = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementationOnce(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    await expect(addGraphitiMessages('group', [{ content: 'slow request' }])).rejects.toThrow(
      /timeout after 1ms/,
    );
  });

  it('waits for queue drain, honors the baseline failure count, and reports new failures', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ pending_jobs: '1', active_jobs: 2, failed_jobs: 4 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ pending_jobs: 0, active_jobs: 0, completed_jobs: 8, failed_jobs: 4 }),
          { status: 200 },
        ),
      );

    await expect(waitForGraphitiQueue({ timeoutMs: 10_000, pollMs: 250 })).resolves.toEqual({
      pendingJobs: 0,
      activeJobs: 0,
      completedJobs: 8,
      failedJobs: 4,
      workers: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ failed_jobs: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ failed_jobs: 3 }), { status: 200 }));
    await expect(
      waitForGraphitiQueue({ timeoutMs: 10_000, baselineFailedJobs: 1 }),
    ).rejects.toThrow('drained with 2 failed job(s)');

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending_jobs: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending_jobs: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending_jobs: 0 }), { status: 200 }));
    await expect(
      waitForGraphitiQueue({ timeoutMs: 10_000, pollMs: 250, baselineFailedJobs: 0 }),
    ).resolves.toMatchObject({ pendingJobs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('times out queue draining without waiting for the wall clock', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockImplementationOnce(async () => {
      now += 10_001;
      return new Response(JSON.stringify({ pending_jobs: 1 }), { status: 200 });
    });

    await expect(waitForGraphitiQueue({ timeoutMs: 10_000, pollMs: 250 })).rejects.toThrow(
      'queue did not drain within 10000ms',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses node summary fallbacks and skips edges without a Graphiti group', async () => {
    await expect(upsertGraphitiNodes([])).resolves.toEqual({ created: 0, updated: 0 });
    await expect(
      upsertGraphitiNodes([
        { id: 'label-fallback', label: 'label', properties: {} },
        { id: 'text-fallback', label: 'label', properties: { segment: 'group', text: 'text' } },
      ]),
    ).resolves.toEqual({ created: 2, updated: 0 });
    await expect(
      upsertGraphitiEdges([{ source: 'a', target: 'b', type: 'knows', properties: {} }]),
    ).resolves.toEqual({ created: 0, updated: 0 });

    const requests = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return body;
    });
    expect(requests[0]).toMatchObject({ group_id: 'betaclaw', summary: 'label' });
    expect(requests[1]).toMatchObject({ group_id: 'group', summary: 'text' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('formats known relation phrases and preserves structured edge attributes', async () => {
    const relationTypes = [
      'is_parent_of',
      'has_pet',
      'can_drive',
      'works_with',
      'lives_in',
      'located_near',
      'likes_music',
      'knows_person',
      'manages_team',
      'uses_tool',
      'prefers_tea',
      'responsible_for',
      'married_to',
    ];
    const edges = relationTypes.map((type, index) => ({
      ...(index === 1 ? { uuid: 'explicit-edge-id' } : {}),
      source: 'person-1',
      target: 'person-2',
      type,
      ...(index === 2 ? { fact: '  explicit fact  ' } : {}),
      sourceLabel: ' Alice ',
      targetLabel: ' Bob ',
      properties: {
        segment: 'safe-group',
        createdAt: index === 0 ? new Date('2026-10-08T12:00:00.000Z') : new Date('invalid'),
        validFrom: index === 0 ? new Date('2026-01-01T00:00:00.000Z') : ' 2026-02-01 ',
        validTo: index === 0 ? new Date('invalid') : '2026-03-01',
        sourceObservationId: 'observation-1',
        eventId: 'event-1',
        priority: 'high',
        omittedEmpty: '',
        omittedNull: null,
        omittedUndefined: undefined,
      },
    }));

    await expect(upsertGraphitiEdges(edges)).resolves.toEqual({
      created: relationTypes.length,
      updated: 0,
    });
    const requests = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    );
    const facts = requests.map((request) => String(request.fact));
    expect(facts[0]).toContain('"Alice" is parent of "Bob"');
    expect(facts[1]).toContain('"Alice" has pet "Bob"');
    expect(facts[2]).toBe('explicit fact');
    expect(facts[3]).toContain('"Alice" works with "Bob"');
    expect(facts[4]).toContain('"Alice" lives in "Bob"');
    expect(facts[5]).toContain('"Alice" located near "Bob"');
    expect(facts[6]).toContain('"Alice" likes music "Bob"');
    expect(facts[7]).toContain('"Alice" knows person "Bob"');
    expect(facts[8]).toContain('"Alice" manages team "Bob"');
    expect(facts[9]).toContain('"Alice" uses tool "Bob"');
    expect(facts[10]).toContain('"Alice" prefers tea "Bob"');
    expect(facts[11]).toContain('"Alice" is responsible for "Bob"');
    expect(facts[12]).toContain('has relation "married to" to');
    expect(facts[0]).toContain('Structured metadata: priority=high.');
    expect(facts[0]).not.toContain('observation-1');
    expect(facts[0]).not.toContain('validFrom');
    expect(facts[0]).not.toContain('validTo');
    expect(requests[0]).toMatchObject({
      uuid: expect.stringMatching(/^edge:[a-f0-9]{32}$/),
      created_at: '2026-10-08T12:00:00.000Z',
      valid_at: '2026-01-01T00:00:00.000Z',
      attributes: {
        sourceObservationId: 'observation-1',
        eventId: 'event-1',
        priority: 'high',
      },
    });
    expect(requests[1]).toMatchObject({ uuid: 'explicit-edge-id' });
    expect(requests[1]?.created_at).toEqual(expect.any(String));
    expect(requests[1]?.valid_at).toBe(' 2026-02-01 ');
    expect(requests[1]?.invalid_at).toBe('2026-03-01');
    expect(requests[1]?.attributes).not.toHaveProperty('segment');
  });
});
