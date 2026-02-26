import { fetchWithTimeout, parseErrorMessage } from '@/server/model-hub/Models/shared/http';
import type { CohereEmbeddingResponse } from '../types';
import { normalizeBearerSecret } from '../utils';
import { normalizeOpenAICompatibleEmbeddingInput } from './openaiCompatible';

export async function dispatchCohereEmbedding(
  secret: string,
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeOpenAICompatibleEmbeddingInput(operation, payload, fallbackModel);
  if (!normalized) {
    return { error: 'Embedding payload is missing a supported model/input format.' };
  }

  const response = await fetchWithTimeout(
    'https://api.cohere.com/v2/embed',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${normalizeBearerSecret(secret)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: normalized.model,
        texts: normalized.input,
        embedding_types: ['float'],
      }),
    },
    60_000,
  );

  if (!response.ok) {
    return { error: await parseErrorMessage(response) };
  }

  const json = (await response.json().catch(() => ({}))) as CohereEmbeddingResponse;
  const rawEmbeddings = Array.isArray(json.embeddings)
    ? json.embeddings
    : Array.isArray(json.embeddings?.float)
      ? json.embeddings.float
      : [];

  const vectors = rawEmbeddings.filter(
    (embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0,
  );

  if (operation === 'embedContent') {
    return { embedding: { values: vectors[0] ?? [] } };
  }
  return { embeddings: vectors.map((values) => ({ values })) };
}
