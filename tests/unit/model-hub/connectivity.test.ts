import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../../src/server/model-hub/crypto';
import type { ProviderAccountRecord } from '../../../src/server/model-hub/repository';
import { testProviderAccountConnectivity } from '../../../src/server/model-hub/connectivity';

const KEY = '0123456789abcdef0123456789abcdef';

function buildAccount(providerId: string, secret: string): ProviderAccountRecord {
  const now = new Date().toISOString();
  return {
    id: `${providerId}-acc`,
    providerId,
    label: providerId,
    authMethod: 'api_key',
    secretMasked: '********1234',
    hasRefreshToken: false,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
    encryptedSecret: encryptSecret(secret, KEY),
    encryptedRefreshToken: null,
  };
}

describe('model-hub connectivity adapters', () => {
  it('calls OpenAI models endpoint for openai provider', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(buildAccount('openai', 'sk-test'), KEY);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('api.openai.com/v1/models');

    global.fetch = originalFetch;
  });

  it('calls OpenRouter key endpoint for openrouter provider', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: { label: 'test-key' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('openrouter', 'or-sk-test'),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('openrouter.ai/api/v1/key');

    global.fetch = originalFetch;
  });

  it('calls OpenAI models endpoint for openai-codex provider', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.3-codex' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('openai-codex', 'codex-access-token'),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('api.openai.com/v1/models');

    global.fetch = originalFetch;
  });

  it('falls back to chat probe for openai-codex when api.model.read scope is missing', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            error:
              'You have insufficient permissions for this operation. Missing scopes: api.model.read.',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'gpt-5.3-codex',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('openai-codex', 'codex-access-token'),
      KEY,
      { model: 'gpt-5.3-codex' },
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    const secondCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]?.[0],
    );
    expect(firstCallUrl).toContain('api.openai.com/v1/models');
    expect(secondCallUrl).toContain('api.openai.com/v1/chat/completions');
    expect(result.message).toContain('chat endpoint reachable');

    global.fetch = originalFetch;
  });

  it('calls GitHub models inference endpoint for github-copilot token', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify([{ id: 'gpt-4o' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const account = {
      ...buildAccount('github-copilot', 'gho_test_token'),
      authMethod: 'oauth' as const,
    };
    const result = await testProviderAccountConnectivity(account, KEY);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('models.inference.ai.azure.com/info');

    global.fetch = originalFetch;
  });
});
