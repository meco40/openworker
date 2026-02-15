import { afterEach, describe, expect, it, vi } from 'vitest';

describe('openai-codex model fetching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges provider models with known codex model seeds', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ id: 'gpt-5.3-codex' }, { id: 'gpt-5.2-codex' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;

    const { default: adapter } = await import(
      '../../../src/server/model-hub/Models/openai-codex/index'
    );

    const models = await adapter.fetchModels?.({
      secret: 'token',
      provider: {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        icon: 'OC',
        authMethods: ['oauth'],
        endpointType: 'openai-native',
        capabilities: ['chat'],
        defaultModels: ['gpt-5.3-codex', 'gpt-5.2-codex'],
      },
      account: {} as never,
    });

    const ids = (models ?? []).map((model) => model.id);
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.2-codex');
    expect(ids).toContain('gpt-5.1-codex');

    global.fetch = originalFetch;
  });

  it('falls back to known codex model seeds when provider model lookup fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as
      typeof fetch;

    const { default: adapter } = await import(
      '../../../src/server/model-hub/Models/openai-codex/index'
    );

    const models = await adapter.fetchModels?.({
      secret: 'token',
      provider: {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        icon: 'OC',
        authMethods: ['oauth'],
        endpointType: 'openai-native',
        capabilities: ['chat'],
        defaultModels: [],
      },
      account: {} as never,
    });

    const ids = (models ?? []).map((model) => model.id);
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.1-codex');

    global.fetch = originalFetch;
  });
});
