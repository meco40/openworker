import { decryptSecret } from '@/server/model-hub/crypto';
import { PROVIDER_CATALOG } from '@/server/model-hub/providerCatalog';
import type { PipelineModelEntry, ProviderAccountRecord } from '@/server/model-hub/repository';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';

const CHAT_PROFILE_ID = 'p1';
const EMBEDDING_PROFILE_ID = 'p1-embeddings';
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const MEM0_PGVECTOR_HNSW_MAX_DIMS = 2000;

interface Mem0ProviderPayload {
  provider: string;
  config: Record<string, unknown>;
}

export interface Mem0EmbedderSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  profileId?: string;
  providerId?: string;
  modelName?: string;
  embeddingDims?: number;
}

export interface Mem0LlmSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  profileId?: string;
  providerId?: string;
  modelName?: string;
}

function normalizeBearerSecret(secret: string): string {
  let normalized = secret.trim();
  normalized = normalized.replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
  normalized = normalized.replace(/^['"`](.*)['"`]$/s, '$1').trim();
  normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  normalized = normalized.replace(/\\[nrt]/g, '');
  normalized = normalized.replace(/[\r\n\t]/g, '');
  return normalized;
}

function asPositiveInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveEmbeddingProfileHead(entries: PipelineModelEntry[]): PipelineModelEntry | null {
  const active = entries
    .filter((entry) => entry.status === 'active')
    .sort((a, b) => a.priority - b.priority);
  return active[0] ?? null;
}

function buildMem0LlmPayload(
  account: ProviderAccountRecord,
  modelName: string,
  decryptedSecret: string,
): Mem0ProviderPayload | null {
  const catalogProvider = PROVIDER_CATALOG.find((entry) => entry.id === account.providerId);
  if (!catalogProvider) return null;

  if (catalogProvider.id === 'gemini') {
    return {
      provider: 'gemini',
      config: {
        api_key: decryptedSecret,
        model: modelName,
        temperature: 0.2,
      },
    };
  }

  // Mem0 openai llm supports arbitrary OpenAI-compatible base URLs.
  if (catalogProvider.apiBaseUrl && catalogProvider.capabilities.includes('chat')) {
    return {
      provider: 'openai',
      config: {
        api_key: normalizeBearerSecret(decryptedSecret),
        model: modelName,
        openai_base_url: catalogProvider.apiBaseUrl,
      },
    };
  }

  return null;
}

function buildMem0EmbedderPayload(
  account: ProviderAccountRecord,
  modelName: string,
  decryptedSecret: string,
): Mem0ProviderPayload | null {
  const catalogProvider = PROVIDER_CATALOG.find((entry) => entry.id === account.providerId);
  if (!catalogProvider) return null;

  if (catalogProvider.id === 'gemini') {
    return {
      provider: 'gemini',
      config: {
        api_key: decryptedSecret,
        model: modelName,
      },
    };
  }

  // Mem0 openai embedder supports arbitrary OpenAI-compatible base URLs.
  if (catalogProvider.apiBaseUrl && catalogProvider.capabilities.includes('embeddings')) {
    return {
      provider: 'openai',
      config: {
        api_key: normalizeBearerSecret(decryptedSecret),
        model: modelName,
        openai_base_url: catalogProvider.apiBaseUrl,
      },
    };
  }

  return null;
}

function resolveMem0SyncTarget(env: NodeJS.ProcessEnv): {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
} | null {
  const provider = String(env.MEMORY_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (provider && provider !== 'mem0') {
    return null;
  }
  const baseUrl = String(env.MEM0_BASE_URL || '').trim();
  const apiKey = String(env.MEM0_API_KEY || '').trim();
  if (!baseUrl || !apiKey) return null;

  const timeoutMs = asPositiveInteger(env.MEM0_EMBEDDER_SYNC_TIMEOUT_MS) ?? DEFAULT_SYNC_TIMEOUT_MS;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, timeoutMs };
}

function extractEmbeddingDims(payload: Record<string, unknown>): number | null {
  const embedding = payload.embedding;
  if (!embedding || typeof embedding !== 'object') return null;
  const values = (embedding as { values?: unknown }).values;
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.length;
}

function resolveProfileHead(service: ReturnType<typeof getModelHubService>, profileId: string) {
  return resolveEmbeddingProfileHead(service.listPipeline(profileId));
}

async function resolveAccountWithSecret(
  service: ReturnType<typeof getModelHubService>,
  accountId: string,
  encryptionKey: string,
) {
  const account = await service.getUsableAccountById(accountId, encryptionKey);
  if (!account) return null;
  const secret = decryptSecret(account.encryptedSecret, encryptionKey);
  if (!secret?.trim()) return null;
  return {
    account,
    secret: secret.trim(),
  };
}

async function probeEmbeddingDims(
  modelName: string,
  encryptionKey: string,
  requestedDims?: number,
): Promise<number | null> {
  const service = getModelHubService();
  const payload: Record<string, unknown> = {
    model: modelName,
    input: ['mem0-dimension-probe'],
  };
  if (requestedDims && requestedDims > 0) {
    payload.dimensions = requestedDims;
  }
  const result = await service.dispatchEmbedding(encryptionKey, {
    operation: 'embedContent',
    payload,
  });
  if (typeof result.error === 'string' && result.error.trim()) {
    return null;
  }
  return extractEmbeddingDims(result);
}

interface Mem0AdminResponse {
  ok: boolean;
  error?: string;
}

async function postMem0Admin(
  syncTarget: { baseUrl: string; apiKey: string; timeoutMs: number },
  endpointPath: string,
  payload: Record<string, unknown>,
): Promise<Mem0AdminResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), syncTarget.timeoutMs);
  try {
    const response = await fetch(`${syncTarget.baseUrl}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${syncTarget.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Mem0 sync failed with HTTP ${response.status}${message ? `: ${message}` : ''}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: `Mem0 sync timeout after ${syncTarget.timeoutMs}ms.` };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown Mem0 sync error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncMem0LlmFromModelHub(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mem0LlmSyncResult> {
  const syncTarget = resolveMem0SyncTarget(env);
  if (!syncTarget) {
    return {
      ok: false,
      skipped: true,
      reason: 'Mem0 runtime not configured; skipping llm sync.',
    };
  }

  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();
  const llmHead = resolveProfileHead(service, CHAT_PROFILE_ID);
  if (!llmHead) {
    return {
      ok: false,
      error: 'No active llm model in p1.',
      profileId: CHAT_PROFILE_ID,
    };
  }

  const accountWithSecret = await resolveAccountWithSecret(service, llmHead.accountId, encryptionKey);
  if (!accountWithSecret) {
    return {
      ok: false,
      error: `LLM account ${llmHead.accountId} not found or secret missing.`,
      profileId: CHAT_PROFILE_ID,
      providerId: llmHead.providerId,
      modelName: llmHead.modelName,
    };
  }

  const llm = buildMem0LlmPayload(
    accountWithSecret.account,
    llmHead.modelName,
    accountWithSecret.secret,
  );
  if (!llm) {
    return {
      ok: false,
      error: `LLM provider "${llmHead.providerId}" is not supported for Mem0 sync.`,
      profileId: CHAT_PROFILE_ID,
      providerId: llmHead.providerId,
      modelName: llmHead.modelName,
    };
  }

  const syncResponse = await postMem0Admin(syncTarget, '/configure/llm', { llm });
  if (!syncResponse.ok) {
    return {
      ok: false,
      error: syncResponse.error,
      profileId: CHAT_PROFILE_ID,
      providerId: llmHead.providerId,
      modelName: llmHead.modelName,
    };
  }

  return {
    ok: true,
    profileId: CHAT_PROFILE_ID,
    providerId: llmHead.providerId,
    modelName: llmHead.modelName,
  };
}

export async function syncMem0EmbedderFromModelHub(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Mem0EmbedderSyncResult> {
  const syncTarget = resolveMem0SyncTarget(env);
  if (!syncTarget) {
    return {
      ok: false,
      skipped: true,
      reason: 'Mem0 runtime not configured; skipping embedder sync.',
    };
  }

  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();
  const embeddingHead = resolveProfileHead(service, EMBEDDING_PROFILE_ID);
  if (!embeddingHead) {
    return {
      ok: false,
      error: 'No active embedding model in p1-embeddings.',
      profileId: EMBEDDING_PROFILE_ID,
    };
  }

  const accountWithSecret = await resolveAccountWithSecret(
    service,
    embeddingHead.accountId,
    encryptionKey,
  );
  if (!accountWithSecret) {
    return {
      ok: false,
      error: `Embedding account ${embeddingHead.accountId} not found or secret missing.`,
      profileId: EMBEDDING_PROFILE_ID,
      providerId: embeddingHead.providerId,
      modelName: embeddingHead.modelName,
    };
  }

  const embedder = buildMem0EmbedderPayload(
    accountWithSecret.account,
    embeddingHead.modelName,
    accountWithSecret.secret,
  );
  if (!embedder) {
    return {
      ok: false,
      error: `Embedding provider "${embeddingHead.providerId}" is not supported for Mem0 sync.`,
      profileId: EMBEDDING_PROFILE_ID,
      providerId: embeddingHead.providerId,
      modelName: embeddingHead.modelName,
    };
  }

  const requestedDims = asPositiveInteger(env.MEM0_EMBEDDING_DIMS);
  const measuredDims = await probeEmbeddingDims(
    embeddingHead.modelName,
    encryptionKey,
    requestedDims ?? undefined,
  );
  const embeddingDims = measuredDims ?? requestedDims;
  if (!embeddingDims) {
    return {
      ok: false,
      error: 'Unable to determine embedding dimensions for Mem0 vector store.',
      profileId: EMBEDDING_PROFILE_ID,
      providerId: embeddingHead.providerId,
      modelName: embeddingHead.modelName,
    };
  }
  if (embeddingDims > MEM0_PGVECTOR_HNSW_MAX_DIMS) {
    return {
      ok: false,
      error:
        `Embedding dimension ${embeddingDims} exceeds Mem0 pgvector/hnsw limit ` +
        `(${MEM0_PGVECTOR_HNSW_MAX_DIMS}). Set MEM0_EMBEDDING_DIMS<=${MEM0_PGVECTOR_HNSW_MAX_DIMS} ` +
        'for providers that support down-projection, or switch to a smaller embedding model.',
      profileId: EMBEDDING_PROFILE_ID,
      providerId: embeddingHead.providerId,
      modelName: embeddingHead.modelName,
      embeddingDims,
    };
  }

  if (embedder.provider === 'openai') {
    embedder.config.embedding_dims = embeddingDims;
  }

  const syncResponse = await postMem0Admin(syncTarget, '/configure/embedder', {
    embedder,
    embedding_model_dims: embeddingDims,
  });
  if (!syncResponse.ok) {
    return {
      ok: false,
      error: syncResponse.error,
      profileId: EMBEDDING_PROFILE_ID,
      providerId: embeddingHead.providerId,
      modelName: embeddingHead.modelName,
      embeddingDims,
    };
  }

  return {
    ok: true,
    profileId: EMBEDDING_PROFILE_ID,
    providerId: embeddingHead.providerId,
    modelName: embeddingHead.modelName,
    embeddingDims,
  };
}
