import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineModelEntry, ProviderAccountRecord } from '@/server/model-hub/repository';

const mocks = vi.hoisted(() => ({
  listPipeline: vi.fn(),
  getUsableAccountById: vi.fn(),
  dispatchEmbedding: vi.fn(),
  getModelHubEncryptionKey: vi.fn(() => 'enc-key'),
  decryptSecret: vi.fn(() => 'secret'),
}));

vi.mock('@/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    listPipeline: mocks.listPipeline,
    getUsableAccountById: mocks.getUsableAccountById,
    dispatchEmbedding: mocks.dispatchEmbedding,
  }),
  getModelHubEncryptionKey: mocks.getModelHubEncryptionKey,
}));

vi.mock('@/server/model-hub/crypto', () => ({
  decryptSecret: mocks.decryptSecret,
}));

function buildEmbeddingPipelineEntry(
  overrides: Partial<PipelineModelEntry> = {},
): PipelineModelEntry {
  return {
    id: 'embed-1',
    profileId: 'p1-embeddings',
    accountId: 'acc-1',
    providerId: 'openrouter',
    modelName: 'qwen/qwen3-embedding-8b',
    priority: 1,
    status: 'active',
    createdAt: '2026-02-24T00:00:00.000Z',
    updatedAt: '2026-02-24T00:00:00.000Z',
    ...overrides,
  };
}

function buildLlmPipelineEntry(overrides: Partial<PipelineModelEntry> = {}): PipelineModelEntry {
  return {
    id: 'llm-1',
    profileId: 'p1',
    accountId: 'acc-1',
    providerId: 'openrouter',
    modelName: 'openai/gpt-4.1-mini',
    priority: 1,
    status: 'active',
    createdAt: '2026-02-24T00:00:00.000Z',
    updatedAt: '2026-02-24T00:00:00.000Z',
    ...overrides,
  };
}

function buildAccount(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  return {
    id: 'acc-1',
    providerId: 'openrouter',
    label: 'OpenRouter',
    authMethod: 'api_key',
    secretMasked: '****',
    hasRefreshToken: false,
    createdAt: '2026-02-24T00:00:00.000Z',
    updatedAt: '2026-02-24T00:00:00.000Z',
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
    ...overrides,
  };
}

describe('syncMem0EmbedderFromModelHub', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://127.0.0.1:8000';
    process.env.MEM0_API_KEY = 'mem0-token';
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  it('skips sync when memory provider is not mem0', async () => {
    process.env.MEMORY_PROVIDER = 'disabled';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an explicit error when no active embedding model exists', async () => {
    mocks.listPipeline.mockReturnValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No active embedding model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('syncs openrouter embedding selection to mem0 openai embedder config', async () => {
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.decryptSecret.mockReturnValue('Bearer openrouter-secret');
    mocks.dispatchEmbedding.mockResolvedValue({
      embedding: { values: [0.1, 0.2, 0.3, 0.4] },
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('openrouter');
    expect(result.modelName).toBe('qwen/qwen3-embedding-8b');
    expect(result.embeddingDims).toBe(4);
    expect(mocks.dispatchEmbedding).toHaveBeenCalledWith('enc-key', {
      operation: 'embedContent',
      payload: {
        model: 'qwen/qwen3-embedding-8b',
        input: ['mem0-dimension-probe'],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0] ?? '')).toBe('http://127.0.0.1:8000/configure/embedder');
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer mem0-token',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      embedder: {
        provider: 'openai',
        config: {
          api_key: 'openrouter-secret',
          model: 'qwen/qwen3-embedding-8b',
          openai_base_url: 'https://openrouter.ai/api/v1',
          embedding_dims: 4,
        },
      },
      embedding_model_dims: 4,
    });
  });

  it('uses MEM0_EMBEDDING_DIMS hint when probing embedder dimensions', async () => {
    process.env.MEM0_EMBEDDING_DIMS = '1536';
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.decryptSecret.mockReturnValue('Bearer openrouter-secret');
    mocks.dispatchEmbedding.mockResolvedValue({
      embedding: { values: Array.from({ length: 1536 }, () => 0.1) },
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(true);
    expect(result.embeddingDims).toBe(1536);
    expect(mocks.dispatchEmbedding).toHaveBeenCalledWith('enc-key', {
      operation: 'embedContent',
      payload: {
        model: 'qwen/qwen3-embedding-8b',
        input: ['mem0-dimension-probe'],
        dimensions: 1536,
      },
    });
  });

  it('syncs openrouter llm selection to mem0 openai llm config', async () => {
    mocks.listPipeline.mockImplementation((profileId: string) => {
      if (profileId === 'p1') return [buildLlmPipelineEntry()];
      return [];
    });
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.decryptSecret.mockReturnValue('Bearer openrouter-secret');

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0LlmFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0LlmFromModelHub();

    expect(result.ok).toBe(true);
    expect(result.profileId).toBe('p1');
    expect(result.providerId).toBe('openrouter');
    expect(result.modelName).toBe('openai/gpt-4.1-mini');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0] ?? '')).toBe('http://127.0.0.1:8000/configure/llm');
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer mem0-token',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      llm: {
        provider: 'openai',
        config: {
          api_key: 'openrouter-secret',
          model: 'openai/gpt-4.1-mini',
          openai_base_url: 'https://openrouter.ai/api/v1',
        },
      },
    });
  });
});
