/**
 * Type definitions for Mem0 client
 */

export interface Mem0ClientConfig {
  baseUrl: string;
  apiPath?: string;
  apiKey?: string;
  /** Legacy/shared timeout; used as read timeout unless readTimeoutMs is provided. */
  timeoutMs?: number;
  /** Timeout for read/list/search/get requests. */
  readTimeoutMs?: number;
  /** Timeout for write/update/delete requests. */
  writeTimeoutMs?: number;
  /** Maximum number of retries for transient HTTP errors (500, 502, 503, 429). Defaults to 0. */
  maxRetries?: number;
  /** Maximum retries for write operations. Defaults to maxRetries. */
  writeMaxRetries?: number;
  /** Base delay in ms before the first retry (doubles on each subsequent retry). Defaults to 500. */
  retryBaseDelayMs?: number;
}

export interface Mem0MemoryInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface Mem0SearchInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  query: string;
  limit: number;
  /** Optional metadata filters passed through to the Mem0 search endpoint. */
  filters?: Record<string, unknown>;
}

export interface Mem0ListInput {
  userId: string;
  personaId?: string;
  workspaceId?: string;
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

export interface Mem0HistoryEntry {
  action: string;
  timestamp?: string;
  content?: string;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface Mem0Scope {
  userId: string;
  personaId: string;
  workspaceId?: string;
}

export type MemoryProviderKind = 'postgres' | 'mem0' | 'sqlite';

export interface Mem0Client {
  /** Identifies the backing store for mapper/health metadata without widening the API. */
  readonly provider?: MemoryProviderKind;
  addMemory(
    input: Mem0MemoryInput,
    signal?: AbortSignal,
  ): Promise<{ id: string | null; created?: boolean }>;
  searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]>;
  listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult>;
  getMemory(id: string, scope?: Mem0Scope): Promise<Mem0MemoryRecord | null>;
  getMemoryHistory(id: string, scope?: Mem0Scope): Promise<Mem0HistoryEntry[]>;
  updateMemory(id: string, input: Mem0MemoryInput, scope?: Mem0Scope): Promise<void>;
  deleteMemory(id: string, scope?: Mem0Scope): Promise<void>;
  deleteMemoriesByFilter(input: { userId: string; personaId: string }): Promise<number>;
}

/** Environment-like object for configuration */
export type EnvLike = Record<string, string | undefined>;

/** Request options for HTTP operations */
export interface RequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryOnTimeout?: boolean;
  /** When provided, aborting this signal will cancel the underlying fetch immediately. */
  signal?: AbortSignal;
}

/** HTTP request initialization */
export interface RequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Record<string, unknown>;
}
