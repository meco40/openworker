import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithPolicy } from '@/server/http/fetchWithPolicy';

describe('fetchWithPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient HTTP statuses and returns eventual success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithPolicy(
      'http://localhost/test',
      {},
      { retries: 1, timeoutMs: 500 },
    );
    const json = (await response.json()) as { ok: boolean };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('retries transient network errors', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithPolicy(
      'http://localhost/test',
      {},
      { retries: 1, timeoutMs: 500 },
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after retry budget is exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithPolicy('http://localhost/test', {}, { retries: 1, timeoutMs: 500 }),
    ).rejects.toThrow('offline');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
