import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAccountRecord } from '@/server/model-hub/repository';
import type { ProviderCatalogEntry } from '@/server/model-hub/types';

function buildAccount(
  providerId: string,
  authMethod: 'none' | 'api_key' = 'api_key',
): ProviderAccountRecord {
  const now = new Date().toISOString();
  return {
    id: `acc-${providerId}`,
    providerId,
    label: providerId,
    authMethod,
    secretMasked: '****',
    hasRefreshToken: false,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
    encryptedSecret: {
      alg: 'aes-256-gcm',
      keyId: 'default',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag',
    },
    encryptedRefreshToken: null,
  };
}

async function setupGateway(options: {
  catalog: ProviderCatalogEntry[];
  adapter?: { dispatchGateway?: ReturnType<typeof vi.fn> } | null;
  decryptSecretReturn?: string;
  openAICompatibleResponse?: {
    ok: boolean;
    text: string;
    model: string;
    provider: string;
    error?: string;
  };
}) {
  vi.resetModules();

  const dispatchOpenAICompatibleChat = vi.fn(async () => {
    return (
      options.openAICompatibleResponse ?? {
        ok: true,
        text: 'ok',
        model: 'gpt-4.1',
        provider: options.catalog[0]?.id ?? 'unknown',
      }
    );
  });
  const decryptSecret = vi.fn(() => options.decryptSecretReturn ?? 'provider-secret');
  const getProviderAdapter = vi.fn(() => options.adapter ?? null);
  const tokenUsageRecord = vi.fn();
  const promptDispatchRecord = vi.fn(() => ({ createdAt: new Date().toISOString() }));

  vi.doMock('../../../src/server/model-hub/providerCatalog', () => ({
    PROVIDER_CATALOG: options.catalog,
  }));
  vi.doMock('../../../src/server/model-hub/Models', () => ({
    getProviderAdapter,
  }));
  vi.doMock('../../../src/server/model-hub/Models/shared/openaiCompatible', () => ({
    dispatchOpenAICompatibleChat,
  }));
  vi.doMock('../../../src/server/model-hub/crypto', () => ({
    decryptSecret,
  }));
  vi.doMock('../../../src/server/stats/tokenUsageRepository', () => ({
    getTokenUsageRepository: () => ({ recordUsage: tokenUsageRecord }),
  }));
  vi.doMock('../../../src/server/stats/promptDispatchRepository', () => ({
    getPromptDispatchRepository: () => ({ recordDispatch: promptDispatchRecord }),
  }));
  vi.doMock('../../../src/server/stats/promptAudit', () => ({
    redactGatewayRequest: (request: unknown) => request,
    estimatePromptTokens: vi.fn(() => 1),
    detectPromptInjection: vi.fn(() => ({ riskLevel: 'low', score: 0, reasons: [] })),
  }));
  vi.doMock('../../../src/server/stats/promptDispatchDiagnostics', () => ({
    markPromptDispatchAttempt: vi.fn(),
    markPromptDispatchError: vi.fn(),
    markPromptDispatchInsert: vi.fn(),
  }));
  vi.doMock('../../../src/server/stats/openRouterPricing', () => ({
    getOpenRouterModelPricing: vi.fn(async () => null),
  }));
  vi.doMock('../../../src/server/stats/xaiPricing', () => ({
    getXaiModelPricing: vi.fn(async () => null),
  }));

  const mod = await import('@/server/model-hub/gateway');
  return {
    dispatchGatewayRequest: mod.dispatchGatewayRequest,
    dispatchOpenAICompatibleChat,
    decryptSecret,
    getProviderAdapter,
    tokenUsageRecord,
    promptDispatchRecord,
  };
}

describe('dispatchGatewayRequest core branching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns unknown-provider error when provider is not in catalog', async () => {
    const { dispatchGatewayRequest } = await setupGateway({
      catalog: [],
    });

    const result = await dispatchGatewayRequest(buildAccount('missing'), 'enc-key', {
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown provider');
  });

  it('returns missing-secret error for authenticated providers', async () => {
    const { dispatchGatewayRequest } = await setupGateway({
      catalog: [
        {
          id: 'openai',
          name: 'OpenAI',
          icon: 'O',
          authMethods: ['api_key'],
          endpointType: 'openai-native',
          capabilities: ['chat'],
          defaultModels: ['gpt-4.1'],
          apiBaseUrl: 'https://api.openai.com/v1',
        },
      ],
      decryptSecretReturn: '   ',
    });

    const result = await dispatchGatewayRequest(buildAccount('openai', 'api_key'), 'enc-key', {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Account secret is missing or empty.');
  });

  it('returns adapter-missing error when no adapter and no apiBaseUrl', async () => {
    const { dispatchGatewayRequest } = await setupGateway({
      catalog: [
        {
          id: 'custom',
          name: 'Custom',
          icon: 'C',
          authMethods: ['none'],
          endpointType: 'openai-compatible',
          capabilities: ['chat'],
          defaultModels: ['m1'],
        },
      ],
      adapter: null,
    });

    const result = await dispatchGatewayRequest(buildAccount('custom', 'none'), 'enc-key', {
      model: 'm1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No gateway adapter for provider');
  });

  it('uses OpenAI-compatible dispatch fallback when provider has apiBaseUrl and no adapter', async () => {
    const { dispatchGatewayRequest, dispatchOpenAICompatibleChat, promptDispatchRecord } =
      await setupGateway({
        catalog: [
          {
            id: 'openrouter',
            name: 'OpenRouter',
            icon: 'R',
            authMethods: ['api_key'],
            endpointType: 'openai-compatible',
            capabilities: ['chat'],
            defaultModels: ['openai/gpt-4.1-mini'],
            apiBaseUrl: 'https://openrouter.ai/api/v1',
          },
        ],
        adapter: null,
        openAICompatibleResponse: {
          ok: true,
          text: 'fallback ok',
          model: 'openai/gpt-4.1-mini',
          provider: 'openrouter',
        },
      });

    const result = await dispatchGatewayRequest(buildAccount('openrouter'), 'enc-key', {
      model: 'openai/gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(dispatchOpenAICompatibleChat).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1',
      'provider-secret',
      'openrouter',
      {
        model: 'openai/gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hello' }],
      },
      {
        signal: undefined,
        onStreamDelta: undefined,
      },
    );
    expect(promptDispatchRecord).toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      text: 'fallback ok',
      model: 'openai/gpt-4.1-mini',
      provider: 'openrouter',
    });
  });
});
