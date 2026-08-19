import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import { EMBEDDING_PROFILE_ID } from '@/server/model-hub/service';

export interface EmbeddingProvider {
  model: string;
  modelVersion: string;
  generateEmbedding(text: string): Promise<number[]>;
}

function resolveModelHubEmbeddingProvider(): EmbeddingProvider | null {
  try {
    const service = getModelHubService();
    const head = service
      .listPipeline(EMBEDDING_PROFILE_ID)
      .filter((entry) => entry.status === 'active')
      .sort((left, right) => left.priority - right.priority)[0];
    if (!head?.modelName.trim()) return null;

    const model = head.modelName.trim();
    const modelVersion = process.env.EMBEDDING_MODEL_VERSION?.trim() || head.id;
    const encryptionKey = getModelHubEncryptionKey();

    return {
      model,
      modelVersion,
      async generateEmbedding(text: string): Promise<number[]> {
        const result = await service.dispatchEmbedding(encryptionKey, {
          operation: 'embedContent',
          payload: { model, input: text },
        });
        if (typeof result.error === 'string' && result.error.trim()) {
          throw new Error(`Model Hub embedding failed: ${result.error}`);
        }

        const embedding = result.embedding;
        const values =
          embedding && typeof embedding === 'object'
            ? (embedding as { values?: unknown }).values
            : undefined;
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
          throw new Error('Model Hub embedding returned no valid numeric vector');
        }
        return values as number[];
      },
    };
  } catch {
    // The environment-based provider remains the explicit fallback for tests,
    // isolated workers, and installations without a Model Hub database.
    return null;
  }
}

function configuredEmbeddingUrl(): string | null {
  const explicit = process.env.EMBEDDING_API_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.OPENAI_BASE_URL?.trim();
  if (base) return `${base.replace(/\/$/, '')}/embeddings`;
  if (process.env.OPENAI_API_KEY?.trim()) return 'https://api.openai.com/v1/embeddings';
  return null;
}

export function getConfiguredEmbeddingProvider(): EmbeddingProvider | null {
  const url = configuredEmbeddingUrl();
  const apiKey = (process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY)?.trim();
  if (!url || !apiKey) return resolveModelHubEmbeddingProvider();

  const model = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';
  const modelVersion = process.env.EMBEDDING_MODEL_VERSION?.trim() || '1';
  return {
    model,
    modelVersion,
    async generateEmbedding(text: string): Promise<number[]> {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1000, Number(process.env.EMBEDDING_TIMEOUT_MS) || 15_000),
      );
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model, input: text }),
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          data?: Array<{ embedding?: unknown }>;
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(body.error?.message || `embedding provider HTTP ${response.status}`);
        }
        const embedding = body.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number')) {
          throw new Error('embedding provider returned no numeric vector');
        }
        return embedding as number[];
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
