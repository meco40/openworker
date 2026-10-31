import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ModelHubRepository,
  PipelineModelEntry,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';
import type { MockProcedure } from '../../helpers/mockProcedure';

function buildAccountView(providerId: string): ProviderAccountView {
  const now = new Date().toISOString();
  return {
    id: `acc-${providerId}`,
    providerId,
    label: providerId,
    authMethod: 'api_key',
    secretMasked: '****',
    hasRefreshToken: false,
    createdAt: now,
    updatedAt: now,
    lastCheckAt: null,
    lastCheckOk: null,
  };
}

function buildAccountRecord(providerId: string): ProviderAccountRecord {
  const base = buildAccountView(providerId);
  return {
    ...base,
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

function buildEmbeddingPipelineEntry(accountId: string): PipelineModelEntry {
  return {
    id: 'embed-1',
    profileId: 'p1-embeddings',
    accountId,
    providerId: 'gemini',
    modelName: 'text-embedding-004',
    priority: 1,
    status: 'active',
    createdAt: '2026-02-23T00:00:00.000Z',
    updatedAt: '2026-02-23T00:00:00.000Z',
  };
}

function createMockRepository(overrides: Partial<ModelHubRepository> = {}): ModelHubRepository {
  return {
    listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([]),
    getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(null),
    updatePipelineModelStatus: vi.fn<MockProcedure>(),
    updatePipelineModelPriority: vi.fn<MockProcedure>(),
    listAccounts: vi.fn<MockProcedure>().mockReturnValue([]),
    createAccount: vi.fn<MockProcedure>(),
    deleteAccount: vi.fn<MockProcedure>(),
    updateAccountCredentials: vi.fn<MockProcedure>(),
    setHealthStatus: vi.fn<MockProcedure>(),
    addPipelineModel: vi.fn<MockProcedure>(),
    removePipelineModel: vi.fn<MockProcedure>(),
    replacePipeline: vi.fn<MockProcedure>(),
    ...overrides,
  };
}

async function setupService(options?: {
  repository?: ModelHubRepository;
  decryptSecretReturn?: string;
  modelsApi?: {
    embedContent: ReturnType<typeof vi.fn>;
    batchEmbedContents?: ReturnType<typeof vi.fn>;
  };
}) {
  vi.resetModules();

  const decryptSecret = vi.fn<() => string>(() => options?.decryptSecretReturn ?? 'gemini-secret');
  vi.doMock('../../../src/server/model-hub/crypto', () => ({
    decryptSecret,
    encryptSecret: vi.fn<MockProcedure>(),
    maskSecret: vi.fn<() => string>(() => '****'),
  }));
  vi.doMock('../../../src/server/model-hub/gateway', () => ({
    dispatchGatewayRequest: vi.fn<MockProcedure>(),
  }));
  vi.doMock('../../../src/server/model-hub/modelFetcher', () => ({
    fetchModelsForAccount: vi.fn<() => Promise<never[]>>(async () => []),
  }));
  vi.doMock('../../../src/server/model-hub/codexAuth', () => ({
    isJwtExpiringSoon: vi.fn<() => boolean>(() => false),
    refreshOpenAICodexToken: vi.fn<MockProcedure>(),
  }));

  const embedContent =
    options?.modelsApi?.embedContent ??
    vi.fn<() => Promise<{ embedding: number[] }>>(async () => ({ embedding: [1, 2, 3] }));
  const batchEmbedContents = options?.modelsApi?.batchEmbedContents;

  const GoogleGenAI = class {
    models: {
      embedContent: typeof embedContent;
      batchEmbedContents?: typeof batchEmbedContents;
    };

    constructor() {
      this.models = {
        embedContent,
        ...(typeof batchEmbedContents === 'function' ? { batchEmbedContents } : {}),
      };
    }
  };
  vi.doMock('@google/genai', () => ({ GoogleGenAI }));

  const { ModelHubService } = await import('@/server/model-hub/service');
  const repository = options?.repository ?? createMockRepository();
  const service = new ModelHubService(repository);
  return { service, repository, decryptSecret, GoogleGenAI, embedContent, batchEmbedContents };
}

describe('ModelHubService.dispatchEmbedding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['ollama', 'lmstudio'])(
    'uses the configured %s endpoint without an API key',
    async (providerId) => {
      const record = { ...buildAccountRecord(providerId), authMethod: 'none' as const };
      const repository = createMockRepository({
        listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([
          {
            ...buildEmbeddingPipelineEntry(record.id),
            providerId,
            modelName: 'local-embedding',
          },
        ]),
        getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(record),
      });
      vi.stubEnv('OLLAMA_BASE_URL', 'http://model-host:11434/');
      vi.stubEnv('LMSTUDIO_BASE_URL', 'http://model-host:1234/v1');
      const fetchMock = vi.fn<
        () => Promise<{ ok: boolean; json: () => Promise<{ data: { embedding: number[] }[] }> }>
      >(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      const { service } = await setupService({ repository, decryptSecretReturn: '' });
      expect(
        await service.dispatchEmbedding('enc-key', {
          operation: 'embedContent',
          payload: { contents: ['local memory'] },
        }),
      ).toEqual({ embedding: { values: [0.1, 0.2] } });
      expect(fetchMock).toHaveBeenCalledWith(
        `http://model-host:${providerId === 'ollama' ? '11434' : '1234'}/v1/embeddings`,
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
    },
  );

  it('returns error when no embedding model is configured', async () => {
    const repository = createMockRepository();
    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({
      error: 'No active embedding model configured. Add one in Gateway Control.',
    });
  });

  it('returns error when embedding account record is missing', async () => {
    const geminiView = buildAccountView('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry(geminiView.id)]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(null),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({ error: 'Embedding account record not found.' });
  });

  it('returns error when decrypted Gemini secret is empty', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const { service } = await setupService({ repository, decryptSecretReturn: '  ' });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({ error: 'Gemini account secret is missing or empty.' });
  });

  it('dispatches embedContent operation directly', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn<() => Promise<{ embedding: { values: number[] } }>>(async () => ({
      embedding: { values: [0.1, 0.2] },
    }));
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent },
    });

    const payload = { model: 'text-embedding-004', contents: ['hello world'] };
    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload,
    });

    expect(embedContent).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ embedding: { values: [0.1, 0.2] } });
  });

  it('uses active embedding pipeline model when payload.model is missing', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const geminiView = buildAccountView('gemini');
    const repository = createMockRepository({
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
      listPipelineModels: vi.fn<(profileId: string) => PipelineModelEntry[]>(
        (profileId: string) => {
          if (profileId !== 'p1-embeddings') return [];
          return [buildEmbeddingPipelineEntry(geminiView.id)];
        },
      ),
    });
    const embedContent = vi.fn<() => Promise<{ embedding: { values: number[] } }>>(async () => ({
      embedding: { values: [3, 2, 1] },
    }));
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent },
    });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { contents: ['hello'] },
    });

    expect(embedContent).toHaveBeenCalledWith({
      model: 'text-embedding-004',
      contents: ['hello'],
    });
    expect(result).toEqual({ embedding: { values: [3, 2, 1] } });
  });

  it('dispatches batchEmbedContents when provider SDK supports it', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn<() => Promise<{ unused: boolean }>>(async () => ({ unused: true }));
    const batchEmbedContents = vi.fn<() => Promise<{ embeddings: { values: number[] }[] }>>(
      async () => ({ embeddings: [{ values: [1, 2, 3] }] }),
    );
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent, batchEmbedContents },
    });

    const payload = {
      requests: [{ model: 'text-embedding-004', contents: ['alpha'] }],
    };
    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'batchEmbedContents',
      payload,
    });

    expect(batchEmbedContents).toHaveBeenCalledWith(payload);
    expect(embedContent).not.toHaveBeenCalled();
    expect(result).toEqual({ embeddings: [{ values: [1, 2, 3] }] });
  });

  it('falls back from batchEmbedContents to embedContent by extracting payload contents', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn<() => Promise<{ embedding: { values: number[] } }>>(async () => ({
      embedding: { values: [9, 9, 9] },
    }));
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent },
    });

    const payload = {
      requests: [
        {
          model: ' text-embedding-004 ',
          contents: ['alpha', { parts: [{ text: 'beta' }] }],
        },
        {
          model: 'text-embedding-004',
          content: { parts: [{ text: 'gamma' }] },
        },
      ],
    };
    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'batchEmbedContents',
      payload,
    });

    expect(embedContent).toHaveBeenCalledWith({
      model: 'text-embedding-004',
      contents: ['alpha', 'beta', 'gamma'],
    });
    expect(result).toEqual({ embedding: { values: [9, 9, 9] } });
  });

  it('returns empty embeddings when batch fallback payload is not extractable', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn<() => Promise<{ shouldNot: string }>>(async () => ({
      shouldNot: 'run',
    }));
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent },
    });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'batchEmbedContents',
      payload: { requests: [{ model: 'text-embedding-004', contents: [] }] },
    });

    expect(embedContent).not.toHaveBeenCalled();
    expect(result).toEqual({ embeddings: [] });
  });

  it('returns unknown operation error for unsupported embedding operation', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'unknown' as never,
      payload: {},
    });

    expect(result).toEqual({ error: 'Unknown embedding operation: unknown' });
  });

  it('returns thrown error message from embedding provider', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listPipelineModels: vi
        .fn<MockProcedure>()
        .mockReturnValue([buildEmbeddingPipelineEntry('acc-gemini')]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn<() => Promise<never>>(async () => {
      throw new Error('provider down');
    });
    const { service } = await setupService({
      repository,
      modelsApi: { embedContent },
    });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({ error: 'provider down' });
  });

  it('dispatches embedContent through openai-compatible embedding endpoint for openrouter', async () => {
    const openrouterRecord = buildAccountRecord('openrouter');
    const repository = createMockRepository({
      listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([
        {
          id: 'embed-or',
          profileId: 'p1-embeddings',
          accountId: openrouterRecord.id,
          providerId: 'openrouter',
          modelName: 'openai/text-embedding-3-small',
          priority: 1,
          status: 'active',
          createdAt: '2026-02-23T00:00:00.000Z',
          updatedAt: '2026-02-23T00:00:00.000Z',
        },
      ]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(openrouterRecord),
    });

    const fetchMock = vi.fn<MockProcedure>(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          data: [{ embedding: [0.11, 0.22, 0.33], index: 0 }],
        }),
        text: async () => '',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { contents: ['hello openrouter'] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const url = String(firstCall?.[0] ?? '');
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    expect(url).toContain('openrouter.ai/api/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'openai/text-embedding-3-small',
      input: ['hello openrouter'],
    });

    expect(result).toEqual({ embedding: { values: [0.11, 0.22, 0.33] } });
  });

  it('forwards dimensions for openai-compatible embedding payloads', async () => {
    const openrouterRecord = buildAccountRecord('openrouter');
    const repository = createMockRepository({
      listPipelineModels: vi.fn<MockProcedure>().mockReturnValue([
        {
          id: 'embed-or-dims',
          profileId: 'p1-embeddings',
          accountId: openrouterRecord.id,
          providerId: 'openrouter',
          modelName: 'qwen/qwen3-embedding-8b',
          priority: 1,
          status: 'active',
          createdAt: '2026-02-23T00:00:00.000Z',
          updatedAt: '2026-02-23T00:00:00.000Z',
        },
      ]),
      getAccountRecordById: vi.fn<MockProcedure>().mockReturnValue(openrouterRecord),
    });

    const fetchMock = vi.fn<MockProcedure>(
      async (_input: RequestInfo | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          data: [{ embedding: [0.1, 0.2], index: 0 }],
        }),
        text: async () => '',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { contents: ['hello openrouter'], dimensions: 1536 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'qwen/qwen3-embedding-8b',
      input: ['hello openrouter'],
      dimensions: 1536,
    });
    expect(result).toEqual({ embedding: { values: [0.1, 0.2] } });
  });
});
