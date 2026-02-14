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

export interface Mem0ListInput {
  userId: string;
  personaId?: string;
  page: number;
  pageSize: number;
  query?: string;
  type?: string;
}

export interface Mem0MemoryRecord {
  id: string;
  content: string;
  score: number | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Mem0SearchHit {
  id: string;
  content: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

export interface Mem0ListMemoryResult {
  memories: Mem0MemoryRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Mem0Client {
  addMemory(input: Mem0MemoryInput): Promise<{ id: string | null }>;
  searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]>;
  listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult>;
  getMemory(id: string): Promise<Mem0MemoryRecord | null>;
  updateMemory(id: string, input: Mem0MemoryInput): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  deleteMemoriesByFilter(input: { userId: string; personaId: string }): Promise<number>;
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

function extractMemories(payload: unknown): unknown[] {
  const root = pickRecord(payload);
  if (Array.isArray(root.memories)) return root.memories;
  if (Array.isArray(root.results)) return root.results;
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function toMemoryRecord(entry: unknown): Mem0MemoryRecord | null {
  const record = pickRecord(entry);
  const nestedMemory = pickRecord(record.memory);
  const id =
    pickString(record.id) ||
    pickString(record.memory_id) ||
    pickString(nestedMemory.id) ||
    '';
  const content =
    pickString(record.memory) ||
    pickString(record.text) ||
    pickString(record.content) ||
    pickString(nestedMemory.text) ||
    pickString(nestedMemory.content) ||
    '';
  if (!id || !content) return null;

  return {
    id,
    content,
    score:
      pickNumber(record.score) ?? pickNumber(record.similarity) ?? pickNumber(record.distance) ?? null,
    metadata: pickRecord(record.metadata),
    createdAt: pickString(record.created_at) || pickString(record.createdAt) || undefined,
    updatedAt: pickString(record.updated_at) || pickString(record.updatedAt) || undefined,
  };
}

function extractHits(payload: unknown): Mem0SearchHit[] {
  return extractMemories(payload)
    .map((entry) => toMemoryRecord(entry))
    .filter((entry): entry is Mem0MemoryRecord => entry !== null)
    .map((entry) => ({
      id: entry.id,
      content: entry.content,
      score: entry.score,
      metadata: entry.metadata,
    }));
}

function extractId(payload: unknown): string | null {
  if (Array.isArray(payload) && payload.length > 0) {
    const first = toMemoryRecord(payload[0]);
    if (first) return first.id;
  }

  const root = pickRecord(payload);
  return (
    pickString(root.id) ||
    pickString(root.memory_id) ||
    pickString(pickRecord(root.memory).id) ||
    pickString(pickRecord(root.data).id)
  );
}

function extractListMeta(payload: unknown, fallbackPage: number, fallbackPageSize: number): {
  total: number;
  page: number;
  pageSize: number;
} {
  const root = pickRecord(payload);
  const pagination = pickRecord(root.pagination);
  const total =
    Number(root.total) ||
    Number(root.count) ||
    Number(root.total_count) ||
    Number(pagination.total) ||
    0;
  const page =
    Number(root.page) ||
    Number(pagination.page) ||
    Number(root.current_page) ||
    fallbackPage;
  const pageSize =
    Number(root.page_size) ||
    Number(root.pageSize) ||
    Number(pagination.page_size) ||
    Number(pagination.pageSize) ||
    fallbackPageSize;

  return {
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : fallbackPage,
    pageSize:
      Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : fallbackPageSize,
  };
}

function extractDeletedCount(payload: unknown): number {
  const root = pickRecord(payload);
  const candidates = [
    Number(root.deleted),
    Number(root.count),
    Number(root.total_deleted),
    Number(root.deleted_count),
  ];

  for (const value of candidates) {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }

  if (Array.isArray(root.deleted_memories)) {
    return root.deleted_memories.length;
  }

  return 0;
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
        messages: [{ role: 'user', content: input.content }],
        user_id: input.userId,
        agent_id: input.personaId,
        metadata: input.metadata,
        infer: false,
      },
    });
    return { id: extractId(payload) };
  }

  async searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]> {
    const payload = await this.requestV2('/memories/search', {
      method: 'POST',
      body: {
        query: input.query,
        filters: {
          user_id: input.userId,
          agent_id: input.personaId,
        },
        top_k: input.limit,
        limit: input.limit,
      },
    });
    return extractHits(payload);
  }

  async listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult> {
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    const filters: Record<string, unknown> = {
      user_id: input.userId,
    };
    if (input.personaId) {
      filters.agent_id = input.personaId;
    }
    if (input.type) {
      filters.type = input.type;
    }

    const payload = await this.requestV2('/memories', {
      method: 'POST',
      body: {
        filters,
        page,
        page_size: pageSize,
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
      },
    });

    const memories = extractMemories(payload)
      .map((entry) => toMemoryRecord(entry))
      .filter((entry): entry is Mem0MemoryRecord => entry !== null);
    const meta = extractListMeta(payload, page, pageSize);
    const total = meta.total > 0 ? meta.total : memories.length;

    return {
      memories,
      total,
      page: meta.page,
      pageSize: meta.pageSize,
    };
  }

  async getMemory(id: string): Promise<Mem0MemoryRecord | null> {
    const payload = await this.request(`/memories/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
    const direct = toMemoryRecord(payload);
    if (direct) return direct;
    return toMemoryRecord(pickRecord(payload).memory);
  }

  async updateMemory(id: string, input: Mem0MemoryInput): Promise<void> {
    await this.request(`/memories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: {
        text: input.content,
        metadata: input.metadata,
        user_id: input.userId,
        agent_id: input.personaId,
      },
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async deleteMemoriesByFilter(input: { userId: string; personaId: string }): Promise<number> {
    const payload = await this.request('/memories', {
      method: 'DELETE',
      body: {
        user_id: input.userId,
        agent_id: input.personaId,
      },
    });
    return extractDeletedCount(payload);
  }

  private async requestV2(
    path: string,
    init: {
      method: 'POST';
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.requestInternal('/v2', path, init);
  }

  private async request(
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.requestInternal(this.apiPath, path, init);
  }

  private async requestInternal(
    apiPath: string,
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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
      const response = await this.fetchImpl(joinUrl(this.baseUrl, apiPath, path), {
        method: init.method,
        headers,
        body: init.body && init.method !== 'GET' ? JSON.stringify(init.body) : undefined,
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
