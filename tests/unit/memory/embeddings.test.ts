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

describe('memory embeddings fallback', () => {
  beforeEach(() => {
    dispatchEmbeddingMock.mockClear();
  });

  it('returns deterministic non-zero fallback vectors when provider embedding fails', async () => {
    const a1 = await getServerEmbedding('Ich trinke Kaffee schwarz');
    const a2 = await getServerEmbedding('Ich trinke Kaffee schwarz');
    const b = await getServerEmbedding('Ich esse Lasagne');

    expect(a1).toHaveLength(768);
    expect(a2).toHaveLength(768);
    expect(b).toHaveLength(768);

    expect(a1.some((value) => value !== 0)).toBe(true);
    expect(b.some((value) => value !== 0)).toBe(true);

    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });
});

