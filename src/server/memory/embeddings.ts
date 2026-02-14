import { getModelHubEncryptionKey, getModelHubService } from '../model-hub/runtime';

const ZERO_VECTOR_SIZE = 768;
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return hash >>> 0;
}

function buildHashedFallbackEmbedding(text: string, size = ZERO_VECTOR_SIZE): number[] {
  const vector = new Array(size).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const hash = hashToken(token);
    const bucket = hash % size;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[bucket] += sign * (1 + Math.log1p(token.length));
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

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
    const single = await service.dispatchEmbedding(encryptionKey, {
      operation: 'embedContent',
      payload: {
        model,
        contents: [text],
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
              model,
              contents: [text],
            },
          ],
        },
      });
      const values = extractEmbeddingValues(batch);
      if (values) return values;
    } catch (batchError) {
      console.error('Batch server embedding fallback also failed:', batchError);
    }

    return buildHashedFallbackEmbedding(text);
  }
}
