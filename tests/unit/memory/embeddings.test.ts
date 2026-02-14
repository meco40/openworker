import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchEmbeddingMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('embedding backend unavailable');
  }),
);

vi.mock('../../../src/server/model-hub/runtime', () => ({
  getModelHubService: () => ({
    dispatchEmbedding: dispatchEmbeddingMock,
  }),
  getModelHubEncryptionKey: () => 'test-encryption-key',
}));

import { getServerEmbedding } from '../../../src/server/memory/embeddings';

describe('memory embeddings', () => {
  beforeEach(() => {
    dispatchEmbeddingMock.mockClear();
  });

  it('throws when provider embedding is unavailable', async () => {
    await expect(getServerEmbedding('Ich trinke Kaffee schwarz')).rejects.toThrow(/embedding/i);
  });
});
