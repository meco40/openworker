import { getModelHubEncryptionKey, getModelHubService } from '../model-hub/runtime';

const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

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
  const model = process.env.MEMORY_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

  try {
    const response = await service.dispatchEmbedding(encryptionKey, {
      operation: 'embedContent',
      payload: {
        model,
        contents: [text],
      },
    });
    const values = extractEmbeddingValues(response);
    if (values) return values;
    throw new Error('Invalid embedContent response format.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown embedding error.';
    throw new Error(`Embedding generation failed: ${message}`);
  }
}
