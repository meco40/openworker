export interface Mem0ClientConfig {
  baseUrl: string;
  apiPath?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface Mem0MemoryInput {
  userId: string;
  personaId: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface Mem0SearchInput {
  userId: string;
  personaId: string;
  query: string;
  limit: number;
}

export interface Mem0SearchHit {
  id: string;
  content: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

export interface Mem0Client {
  addMemory(input: Mem0MemoryInput): Promise<{ id: string | null }>;
  searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]>;
  updateMemory(id: string, input: Mem0MemoryInput): Promise<void>;
  deleteMemory(id: string): Promise<void>;
}

type EnvLike = Record<string, string | undefined>;

const DEFAULT_TIMEOUT_MS = 5000;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizeApiPath(path: string): string {
  if (!path.trim()) return '/v1';
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  return withLeading.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, apiPath: string, resourcePath: string): string {
  const suffix = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizeApiPath(apiPath)}${suffix}`;
}

function pickRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function extractHits(payload: unknown): Mem0SearchHit[] {
  const root = pickRecord(payload);
  const list = Array.isArray(root.memories)
    ? root.memories
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(payload)
        ? payload
        : [];

  const hits: Mem0SearchHit[] = [];
  for (const entry of list) {
    const record = pickRecord(entry);
    const id =
      pickString(record.id) ||
      pickString(record.memory_id) ||
      pickString(pickRecord(record.memory).id) ||
      '';
    const content =
      pickString(record.memory) ||
      pickString(record.text) ||
      pickString(record.content) ||
      pickString(pickRecord(record.memory).text) ||
      pickString(pickRecord(record.memory).content) ||
      '';
    if (!id || !content) continue;

    hits.push({
      id,
      content,
      score:
        pickNumber(record.score) ?? pickNumber(record.similarity) ?? pickNumber(record.distance) ?? null,
      metadata: pickRecord(record.metadata),
    });
  }

  return hits;
}

function extractId(payload: unknown): string | null {
  const root = pickRecord(payload);
  return (
    pickString(root.id) ||
    pickString(root.memory_id) ||
    pickString(pickRecord(root.memory).id) ||
    pickString(pickRecord(root.data).id)
  );
}

class HttpMem0Client implements Mem0Client {
  private readonly baseUrl: string;
  private readonly apiPath: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Mem0ClientConfig, fetchImpl: typeof fetch) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiPath = normalizeApiPath(config.apiPath || '/v1');
    this.apiKey = config.apiKey?.trim() || undefined;
    this.timeoutMs = Number.isFinite(config.timeoutMs)
      ? Math.max(100, Math.floor(config.timeoutMs as number))
      : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
  }

  async addMemory(input: Mem0MemoryInput): Promise<{ id: string | null }> {
    const payload = await this.request('/memories', {
      method: 'POST',
      body: {
        memory: input.content,
        user_id: input.userId,
        agent_id: input.personaId,
        metadata: input.metadata,
      },
    });
    return { id: extractId(payload) };
  }

  async searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]> {
    const payload = await this.request('/memories/search', {
      method: 'POST',
      body: {
        query: input.query,
        user_id: input.userId,
        agent_id: input.personaId,
        limit: input.limit,
      },
    });
    return extractHits(payload);
  }

  async updateMemory(id: string, input: Mem0MemoryInput): Promise<void> {
    await this.request(`/memories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        memory: input.content,
        user_id: input.userId,
        agent_id: input.personaId,
        metadata: input.metadata,
      },
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private async request(
    path: string,
    init: {
      method: 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, this.apiPath, path), {
        method: init.method,
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        throw new Error(`Mem0 request failed with HTTP ${response.status}.`);
      }
      return payload;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Mem0 request timeout after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createMem0Client(config: Mem0ClientConfig, fetchImpl: typeof fetch = fetch): Mem0Client {
  if (!config.baseUrl || !config.baseUrl.trim()) {
    throw new Error('Mem0 baseUrl is required.');
  }
  return new HttpMem0Client(config, fetchImpl);
}

export function createMem0ClientFromEnv(
  env: EnvLike = process.env as EnvLike,
  fetchImpl: typeof fetch = fetch,
): Mem0Client | null {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const isProduction = nodeEnv === 'production';
  const provider = String(env.MEMORY_PROVIDER || '').trim().toLowerCase();
  if (isProduction && provider !== 'mem0') {
    throw new Error('Invalid memory configuration: production requires MEMORY_PROVIDER=mem0.');
  }
  if (provider && provider !== 'mem0') return null;

  const baseUrl = String(env.MEM0_BASE_URL || '').trim();
  if (provider === 'mem0' && !baseUrl) {
    throw new Error('Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0.');
  }
  if (!baseUrl) return null;

  const timeoutRaw = Number(env.MEM0_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(100, Math.floor(timeoutRaw)) : DEFAULT_TIMEOUT_MS;

  return createMem0Client(
    {
      baseUrl,
      apiKey: String(env.MEM0_API_KEY || '').trim() || undefined,
      apiPath: String(env.MEM0_API_PATH || '/v1').trim() || '/v1',
      timeoutMs,
    },
    fetchImpl,
  );
}
