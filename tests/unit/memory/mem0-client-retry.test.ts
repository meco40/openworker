import { describe, expect, it, vi } from 'vitest';
import { createMem0Client, type Mem0ClientConfig } from '../../../src/server/memory/mem0Client';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_CONFIG: Mem0ClientConfig = {
  baseUrl: 'http://mem0.local',
  apiPath: '/v1',
  timeoutMs: 5000,
  maxRetries: 3,
  retryBaseDelayMs: 10,
};

describe('mem0Client retry', () => {
  it('retries transient HTTP 500 and succeeds on second attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, 'connection pool exhausted'))
      .mockResolvedValueOnce(okResponse([{ id: 'mem-1', memory: 'ok', score: null, metadata: {} }]));

    const client = createMem0Client(BASE_CONFIG, fetchMock as unknown as typeof fetch);

    const result = await client.addMemory({
      userId: 'user-1',
      personaId: 'persona-1',
      content: 'retry test',
      metadata: {},
    });

    expect(result.id).toBe('mem-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 502 and 503 as transient errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(errorResponse(503, 'service unavailable'))
      .mockResolvedValueOnce(okResponse([{ id: 'mem-2', memory: 'ok', score: null, metadata: {} }]));

    const client = createMem0Client(BASE_CONFIG, fetchMock as unknown as typeof fetch);

    const result = await client.addMemory({
      userId: 'user-1',
      personaId: 'persona-1',
      content: 'gateway retry',
      metadata: {},
    });

    expect(result.id).toBe('mem-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors like HTTP 400 or 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400, 'bad request'));

    const client = createMem0Client(BASE_CONFIG, fetchMock as unknown as typeof fetch);

    await expect(
      client.addMemory({
        userId: 'user-1',
        personaId: 'persona-1',
        content: 'no retry',
        metadata: {},
      }),
    ).rejects.toThrow(/HTTP 400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries and throws the last error', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(errorResponse(500, 'pool exhausted')),
      );

    const client = createMem0Client(BASE_CONFIG, fetchMock as unknown as typeof fetch);

    await expect(
      client.addMemory({
        userId: 'user-1',
        personaId: 'persona-1',
        content: 'exhaust retries',
        metadata: {},
      }),
    ).rejects.toThrow(/HTTP 500.*pool exhausted/);

    // 1 initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('defaults to zero retries when maxRetries is not configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500, 'pool exhausted'));

    const client = createMem0Client(
      { baseUrl: 'http://mem0.local', apiPath: '/v1' },
      fetchMock as unknown as typeof fetch,
    );

    await expect(
      client.addMemory({
        userId: 'user-1',
        personaId: 'persona-1',
        content: 'no retries configured',
        metadata: {},
      }),
    ).rejects.toThrow(/HTTP 500/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
