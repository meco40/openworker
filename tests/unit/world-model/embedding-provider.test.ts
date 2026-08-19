import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const modelHubMocks = vi.hoisted(() => ({
  getModelHubEncryptionKey: vi.fn(() => 'test-encryption-key'),
  getModelHubService: vi.fn(),
}));

vi.mock('@/server/model-hub/runtime', () => modelHubMocks);

type GetConfiguredEmbeddingProvider =
  typeof import('@/server/world-model/embeddings/provider').getConfiguredEmbeddingProvider;

describe('world-model embedding provider', () => {
  let getConfiguredEmbeddingProvider: GetConfiguredEmbeddingProvider;
  const originalEmbeddingApiUrl = process.env.EMBEDDING_API_URL;
  const originalEmbeddingApiKey = process.env.EMBEDDING_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalEmbeddingModelVersion = process.env.EMBEDDING_MODEL_VERSION;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_MODEL_VERSION;
  });

  beforeEach(async () => {
    ({ getConfiguredEmbeddingProvider } = await import('@/server/world-model/embeddings/provider'));
  });

  afterEach(() => {
    if (originalEmbeddingApiUrl === undefined) delete process.env.EMBEDDING_API_URL;
    else process.env.EMBEDDING_API_URL = originalEmbeddingApiUrl;
    if (originalEmbeddingApiKey === undefined) delete process.env.EMBEDDING_API_KEY;
    else process.env.EMBEDDING_API_KEY = originalEmbeddingApiKey;
    if (originalOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalEmbeddingModelVersion === undefined) delete process.env.EMBEDDING_MODEL_VERSION;
    else process.env.EMBEDDING_MODEL_VERSION = originalEmbeddingModelVersion;
  });

  it('uses the active Model Hub embedding pipeline when no env override exists', async () => {
    const dispatchEmbedding = vi.fn(async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }));
    modelHubMocks.getModelHubService.mockReturnValue({
      listPipeline: vi.fn(() => [
        {
          id: 'pipeline-entry-1',
          modelName: 'qwen/qwen3-embedding-8b',
          priority: 1,
          status: 'active',
        },
      ]),
      dispatchEmbedding,
    });

    const provider = getConfiguredEmbeddingProvider();

    expect(provider).toMatchObject({
      model: 'qwen/qwen3-embedding-8b',
      modelVersion: 'pipeline-entry-1',
    });
    await expect(provider?.generateEmbedding('hello world')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(dispatchEmbedding).toHaveBeenCalledWith('test-encryption-key', {
      operation: 'embedContent',
      payload: { model: 'qwen/qwen3-embedding-8b', input: 'hello world' },
    });
  });

  it('uses an explicit embedding environment provider before Model Hub', () => {
    process.env.EMBEDDING_API_URL = 'https://embedding.example/v1/embeddings';
    process.env.EMBEDDING_API_KEY = 'test-key';
    modelHubMocks.getModelHubService.mockImplementation(() => {
      throw new Error('Model Hub must not be consulted for explicit env configuration');
    });

    expect(getConfiguredEmbeddingProvider()).toMatchObject({
      model: 'text-embedding-3-small',
      modelVersion: '1',
    });
    expect(modelHubMocks.getModelHubService).not.toHaveBeenCalled();
  });

  it('reports provider errors instead of persisting an invalid vector', async () => {
    modelHubMocks.getModelHubService.mockReturnValue({
      listPipeline: vi.fn(() => [
        {
          id: 'pipeline-entry-1',
          modelName: 'qwen/qwen3-embedding-8b',
          priority: 1,
          status: 'active',
        },
      ]),
      dispatchEmbedding: vi.fn(async () => ({ error: 'provider unavailable' })),
    });

    const provider = getConfiguredEmbeddingProvider();

    await expect(provider?.generateEmbedding('hello world')).rejects.toThrow(
      'Model Hub embedding failed: provider unavailable',
    );
  });
});
