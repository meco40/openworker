import { getModelHubEncryptionKey, getModelHubService } from '../model-hub/runtime';

const ZERO_VECTOR_SIZE = 768;

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function extractEmbeddingValues(payload: unknown): number[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as {
    embedding?: { values?: unknown };
    embeddings?: Array<{ values?: unknown }>;
  };

  if (isNumberArray(data.embedding?.values)) return data.embedding.values;
  if (isNumberArray(data.embeddings?.[0]?.values)) return data.embeddings[0].values;
  return null;
}

export async function getServerEmbedding(text: string): Promise<number[]> {
  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();

  try {
    const single = await service.dispatchEmbedding(encryptionKey, {
      operation: 'embedContent',
      payload: {
        model: 'text-embedding-004',
        content: { parts: [{ text }] },
      },
    });
    const values = extractEmbeddingValues(single);
    if (values) return values;
    throw new Error('Invalid embedContent response format.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('Primary server embedding attempt failed, trying batch fallback:', message);

    try {
      const batch = await service.dispatchEmbedding(encryptionKey, {
        operation: 'batchEmbedContents',
        payload: {
          requests: [
            {
              model: 'text-embedding-004',
              content: { parts: [{ text }] },
            },
          ],
        },
      });
      const values = extractEmbeddingValues(batch);
      if (values) return values;
    } catch (batchError) {
      console.error('Batch server embedding fallback also failed:', batchError);
    }

    return new Array(ZERO_VECTOR_SIZE).fill(0);
  }
}
