import { afterEach, describe, expect, it, vi } from 'vitest';

describe('kimi model fetching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns provider default model when remote models endpoint is empty', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { default: adapter } = await import('@/server/model-hub/Models/kimi/index');

    const models = await adapter.fetchModels?.({
      secret: 'sk-kimi-test',
      provider: {
        id: 'kimi',
        name: 'Kimi Code',
        icon: 'K',
        authMethods: ['api_key'],
        endpointType: 'openai-compatible',
        capabilities: ['chat', 'tools'],
        defaultModels: ['kimi-for-coding'],
      },
      account: {} as never,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const ids = (models ?? []).map((model) => model.id);
    expect(ids).toContain('kimi-for-coding');

    global.fetch = originalFetch;
  });
});
