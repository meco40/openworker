import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ModelHubRepository,
  ProviderAccountRecord,
  ProviderAccountView,
} from '@/server/model-hub/repository';

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

function createMockRepository(overrides: Partial<ModelHubRepository> = {}): ModelHubRepository {
  return {
    listPipelineModels: vi.fn().mockReturnValue([]),
    getAccountRecordById: vi.fn().mockReturnValue(null),
    updatePipelineModelStatus: vi.fn(),
    updatePipelineModelPriority: vi.fn(),
    listAccounts: vi.fn().mockReturnValue([]),
    createAccount: vi.fn(),
    deleteAccount: vi.fn(),
    updateAccountCredentials: vi.fn(),
    setHealthStatus: vi.fn(),
    addPipelineModel: vi.fn(),
    removePipelineModel: vi.fn(),
    replacePipeline: vi.fn(),
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

  const decryptSecret = vi.fn(() => options?.decryptSecretReturn ?? 'gemini-secret');
  vi.doMock('../../../src/server/model-hub/crypto', () => ({
    decryptSecret,
    encryptSecret: vi.fn(),
    maskSecret: vi.fn(() => '****'),
  }));
  vi.doMock('../../../src/server/model-hub/gateway', () => ({
    dispatchGatewayRequest: vi.fn(),
  }));
  vi.doMock('../../../src/server/model-hub/modelFetcher', () => ({
    fetchModelsForAccount: vi.fn(async () => []),
  }));
  vi.doMock('../../../src/server/model-hub/codexAuth', () => ({
    isJwtExpiringSoon: vi.fn(() => false),
    refreshOpenAICodexToken: vi.fn(),
  }));

  const embedContent =
    options?.modelsApi?.embedContent ?? vi.fn(async () => ({ embedding: [1, 2, 3] }));
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
    vi.resetModules();
  });

  it('returns error when no Gemini account exists', async () => {
    const repository = createMockRepository({
      listAccounts: vi.fn().mockReturnValue([buildAccountView('openai')]),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({ error: 'No Gemini account available for embeddings.' });
  });

  it('returns error when Gemini account record is missing', async () => {
    const geminiView = buildAccountView('gemini');
    const repository = createMockRepository({
      listAccounts: vi.fn().mockReturnValue([geminiView]),
      getAccountRecordById: vi.fn().mockReturnValue(null),
    });
    const { service } = await setupService({ repository });

    const result = await service.dispatchEmbedding('enc-key', {
      operation: 'embedContent',
      payload: { model: 'text-embedding-004', contents: ['hello'] },
    });

    expect(result).toEqual({ error: 'Gemini account record not found.' });
  });

  it('returns error when decrypted Gemini secret is empty', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
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
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn(async () => ({ embedding: { values: [0.1, 0.2] } }));
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

  it('dispatches batchEmbedContents when provider SDK supports it', async () => {
    const geminiRecord = buildAccountRecord('gemini');
    const repository = createMockRepository({
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn(async () => ({ unused: true }));
    const batchEmbedContents = vi.fn(async () => ({ embeddings: [{ values: [1, 2, 3] }] }));
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
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn(async () => ({ embedding: { values: [9, 9, 9] } }));
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
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn(async () => ({ shouldNot: 'run' }));
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
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
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
      listAccounts: vi.fn().mockReturnValue([buildAccountView('gemini')]),
      getAccountRecordById: vi.fn().mockReturnValue(geminiRecord),
    });
    const embedContent = vi.fn(async () => {
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
});
