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

function buildNoAuthAccount(providerId: string): ProviderAccountRecord {
  const now = new Date().toISOString();
  return {
    id: `${providerId}-acc`,
    providerId,
    label: providerId,
    authMethod: 'none',
    secretMasked: '********',
    hasRefreshToken: false,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
    encryptedSecret: encryptSecret('', KEY),
    encryptedRefreshToken: null,
  };
}

function buildCodexAccessToken(accountId = 'acct_test'): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64url');
  return `header.${payload}.signature`;
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

  it('routes kimi keys to kimi code endpoint and normalizes Bearer prefix', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'moonshot-v1-8k' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('kimi', 'Bearer sk-kimi-test'),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('api.kimi.com/coding/v1/models');
    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
    };
    expect(firstCallInit?.headers?.Authorization).toBe('Bearer sk-kimi-test');

    global.fetch = originalFetch;
  });

  it('uses kimi code endpoint for non sk-kimi keys as well', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('kimi', 'sk-moonshot-platform'),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('api.kimi.com/coding/v1/models');

    global.fetch = originalFetch;
  });

  it('normalizes quoted and multiline kimi API keys', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'moonshot-v1-8k' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('kimi', '"Bearer sk-kimi-test\\n"'),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
    };
    expect(firstCallInit?.headers?.Authorization).toBe('Bearer sk-kimi-test');

    global.fetch = originalFetch;
  });

  it('returns actionable kimi auth error for invalid_authentication_error', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Invalid Authentication',
            type: 'invalid_authentication_error',
          },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(buildAccount('kimi', 'sk-invalid'), KEY);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('invalid_authentication_error');
    expect(result.message).toContain('api.kimi.com/coding/v1');
    expect(result.message).toContain('sk-kimi-');

    global.fetch = originalFetch;
  });

  it('calls ChatGPT Codex responses endpoint for openai-codex provider', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"pong"}',
        '',
        'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.3-codex","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
        '',
      ].join('\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(
      buildAccount('openai-codex', buildCodexAccessToken('acct_conn')),
      KEY,
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('chatgpt.com/backend-api/codex/responses');
    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
      body?: string;
    };
    expect(firstCallInit?.headers?.['chatgpt-account-id']).toBe('acct_conn');
    expect(firstCallInit?.headers?.['OpenAI-Beta']).toBe('responses=experimental');
    const firstCallBody = JSON.parse(firstCallInit?.body || '{}') as {
      instructions?: string;
      max_output_tokens?: unknown;
      temperature?: unknown;
    };
    expect(typeof firstCallBody.instructions).toBe('string');
    expect(firstCallBody.instructions?.length).toBeGreaterThan(0);
    expect(firstCallBody.max_output_tokens).toBeUndefined();
    expect(firstCallBody.temperature).toBeUndefined();

    global.fetch = originalFetch;
  });

  it('fails openai-codex connectivity when account id cannot be extracted from token', async () => {
    const result = await testProviderAccountConnectivity(
      buildAccount('openai-codex', 'not-a-jwt'),
      KEY,
      { model: 'gpt-5.3-codex' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('chatgpt_account_id');
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

  it('supports ollama connectivity without auth token', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(buildNoAuthAccount('ollama'), KEY);
    expect(result.ok).toBe(true);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('localhost:11434/api/tags');
    const firstCallInit = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      headers?: Record<string, string>;
    };
    expect(firstCallInit?.headers?.Authorization).toBeUndefined();

    global.fetch = originalFetch;
  });

  it('supports lmstudio connectivity without auth token', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await testProviderAccountConnectivity(buildNoAuthAccount('lmstudio'), KEY);
    expect(result.ok).toBe(true);
    const firstCallUrl = String(
      (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    );
    expect(firstCallUrl).toContain('localhost:1234/v1/models');

    global.fetch = originalFetch;
  });
});
