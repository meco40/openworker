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
    vi.useRealTimers();
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

  it('normalizes Gemini embedding model names before probing and syncing mem0', async () => {
    mocks.listPipeline.mockReturnValue([
      buildEmbeddingPipelineEntry({
        providerId: 'gemini',
        modelName: 'models/text-embedding-004',
      }),
    ]);
    mocks.getUsableAccountById.mockResolvedValue(
      buildAccount({
        providerId: 'gemini',
      }),
    );
    mocks.decryptSecret.mockReturnValue('gemini-secret');
    mocks.dispatchEmbedding.mockResolvedValue({
      embedding: { values: Array.from({ length: 768 }, () => 0.1) },
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
    expect(result.providerId).toBe('gemini');
    expect(result.modelName).toBe('text-embedding-004');
    expect(mocks.dispatchEmbedding).toHaveBeenCalledWith('enc-key', {
      operation: 'embedContent',
      payload: {
        model: 'text-embedding-004',
        input: ['mem0-dimension-probe'],
      },
    });

    const firstCall = fetchMock.mock.calls[0];
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      embedder: {
        provider: 'gemini',
        config: {
          api_key: 'gemini-secret',
          model: 'text-embedding-004',
        },
      },
      embedding_model_dims: 768,
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

  it('syncs Gemini llm models after removing the models prefix', async () => {
    mocks.listPipeline.mockImplementation((profileId: string) =>
      profileId === 'p1'
        ? [buildLlmPipelineEntry({ providerId: 'gemini', modelName: 'models/gemini-2.5-flash' })]
        : [],
    );
    mocks.getUsableAccountById.mockResolvedValue(buildAccount({ providerId: 'gemini' }));
    mocks.decryptSecret.mockReturnValue('gemini-secret');

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0LlmFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0LlmFromModelHub();

    expect(result).toMatchObject({ ok: true, providerId: 'gemini', modelName: 'gemini-2.5-flash' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      llm: {
        provider: 'gemini',
        config: { api_key: 'gemini-secret', model: 'gemini-2.5-flash', temperature: 0.2 },
      },
    });
  });

  it('returns actionable LLM errors for missing models, credentials, and providers', async () => {
    const { syncMem0LlmFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mocks.listPipeline.mockReturnValue([]);
    expect((await syncMem0LlmFromModelHub()).error).toContain('No active llm model');

    mocks.listPipeline.mockReturnValue([buildLlmPipelineEntry({ modelName: '  ' })]);
    expect((await syncMem0LlmFromModelHub()).error).toContain('No llm model name');

    mocks.listPipeline.mockReturnValue([buildLlmPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(null);
    expect((await syncMem0LlmFromModelHub()).error).toContain('account acc-1 not found');

    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.decryptSecret.mockReturnValue('  ');
    expect((await syncMem0LlmFromModelHub()).error).toContain('secret missing');

    mocks.decryptSecret.mockReturnValue('secret');
    mocks.listPipeline.mockReturnValue([buildLlmPipelineEntry({ providerId: 'unknown-provider' })]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount({ providerId: 'unknown-provider' }));
    expect((await syncMem0LlmFromModelHub()).error).toContain(
      'provider "unknown-provider" is not supported',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns explicit errors when an embedding model, account, secret, or supported provider is missing', async () => {
    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry({ modelName: '' })]);
    expect((await syncMem0EmbedderFromModelHub()).error).toContain('No embedding model name');

    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(null);
    expect((await syncMem0EmbedderFromModelHub()).error).toContain('account acc-1 not found');

    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.decryptSecret.mockReturnValue(' ');
    expect((await syncMem0EmbedderFromModelHub()).error).toContain('secret missing');

    mocks.decryptSecret.mockReturnValue('secret');
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry({ providerId: 'opencode' })]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount({ providerId: 'opencode' }));
    expect((await syncMem0EmbedderFromModelHub()).error).toContain(
      'provider "opencode" is not supported',
    );

    mocks.listPipeline.mockReturnValue([
      buildEmbeddingPipelineEntry({ providerId: 'unknown-provider' }),
    ]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount({ providerId: 'unknown-provider' }));
    expect((await syncMem0EmbedderFromModelHub()).error).toContain(
      'provider "unknown-provider" is not supported',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips LLM sync when Mem0 credentials are not configured', async () => {
    process.env.MEM0_API_KEY = '';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0LlmFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0LlmFromModelHub();

    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the requested dimension hint when the probe returns no usable embedding', async () => {
    process.env.MEM0_EMBEDDING_DIMS = '1536';
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: { values: [] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result).toMatchObject({ ok: true, embeddingDims: 1536 });
  });

  it('uses the requested dimension hint when the embedding probe reports an error', async () => {
    process.env.MEM0_EMBEDDING_DIMS = '768';
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ error: 'provider temporarily unavailable' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result).toMatchObject({ ok: true, embeddingDims: 768 });
  });

  it('fails when neither the embedding probe nor a dimension hint provides a size', async () => {
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unable to determine embedding dimensions');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects dimensions beyond the configured pgvector HNSW limit', async () => {
    process.env.MEM0_EMBEDDING_DIMS = '2048';
    process.env.MEM0_VECTOR_HNSW = 'yes';
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: { values: Array(2048).fill(0.1) } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('exceeds Mem0 pgvector/hnsw limit');
    expect(result.embeddingDims).toBe(2048);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns Mem0 HTTP errors with the response body', async () => {
    mocks.listPipeline.mockImplementation((profileId: string) =>
      profileId === 'p1' ? [buildLlmPipelineEntry()] : [],
    );
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('service unavailable', { status: 503 })),
    );

    const { syncMem0LlmFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0LlmFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Mem0 sync failed with HTTP 503: service unavailable');
  });

  it('returns network failures from the Mem0 request', async () => {
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: { values: [0.1] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('connection refused'))),
    );

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  it('handles non-Error Mem0 request failures', async () => {
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: { values: [0.1] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject('network failure')),
    );

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const result = await syncMem0EmbedderFromModelHub();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unknown Mem0 sync error');
  });

  it('reports Mem0 request timeouts', async () => {
    vi.useFakeTimers();
    process.env.MEM0_EMBEDDER_SYNC_TIMEOUT_MS = '5';
    mocks.listPipeline.mockReturnValue([buildEmbeddingPipelineEntry()]);
    mocks.getUsableAccountById.mockResolvedValue(buildAccount());
    mocks.dispatchEmbedding.mockResolvedValue({ embedding: { values: [0.1, 0.2] } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );

    const { syncMem0EmbedderFromModelHub } = await import('@/server/memory/mem0EmbedderSync');
    const pending = syncMem0EmbedderFromModelHub();
    await vi.advanceTimersByTimeAsync(5);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Mem0 sync timeout after 5ms.');
  });
});
