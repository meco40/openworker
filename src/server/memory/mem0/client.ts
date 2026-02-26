/**
 * Main Mem0 HTTP client implementation
 */

import type {
  Mem0Client,
  Mem0ClientConfig,
  Mem0MemoryInput,
  Mem0SearchInput,
  Mem0ListInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0ListMemoryResult,
  Mem0HistoryEntry,
  RequestOptions,
  EnvLike,
} from './types';
import { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BASE_DELAY_MS } from './constants';
import { extractErrorDetail } from './utils';
import {
  normalizeBaseUrl,
  normalizeApiPath,
  joinUrl,
  isTransientHttpError,
  isTimeoutError,
  isMem0RuntimeUnconfiguredError,
  sleep,
} from './utils/http';
import { triggerMem0ModelHubSync } from './sync';
import { createStoreOperation, createUpdateOperation } from './operations/store';
import {
  createSearchOperation,
  createListOperation,
  createGetOperation,
  createGetHistoryOperation,
} from './operations/recall';
import { createDeleteOperation, createDeleteByFilterOperation } from './operations/delete';

/**
 * HTTP implementation of the Mem0 client
 */
class HttpMem0Client implements Mem0Client {
  private readonly baseUrl: string;
  private readonly apiPath: string;
  private readonly apiKey?: string;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly writeMaxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  // Bound operation methods
  public readonly addMemory: (input: Mem0MemoryInput) => Promise<{ id: string | null }>;
  public readonly updateMemory: (id: string, input: Mem0MemoryInput) => Promise<void>;
  public readonly searchMemories: (input: Mem0SearchInput) => Promise<Mem0SearchHit[]>;
  public readonly listMemories: (input: Mem0ListInput) => Promise<Mem0ListMemoryResult>;
  public readonly getMemory: (id: string) => Promise<Mem0MemoryRecord | null>;
  public readonly getMemoryHistory: (id: string) => Promise<Mem0HistoryEntry[]>;
  public readonly deleteMemory: (id: string) => Promise<void>;
  public readonly deleteMemoriesByFilter: (input: {
    userId: string;
    personaId: string;
  }) => Promise<number>;

  constructor(config: Mem0ClientConfig, fetchImpl: typeof fetch) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiPath = normalizeApiPath(config.apiPath || '/v1');
    this.apiKey = config.apiKey?.trim() || undefined;
    const baseTimeoutMs = Number.isFinite(config.timeoutMs)
      ? Math.max(100, Math.floor(config.timeoutMs as number))
      : DEFAULT_TIMEOUT_MS;
    this.readTimeoutMs = Number.isFinite(config.readTimeoutMs)
      ? Math.max(100, Math.floor(config.readTimeoutMs as number))
      : baseTimeoutMs;
    this.writeTimeoutMs = Number.isFinite(config.writeTimeoutMs)
      ? Math.max(100, Math.floor(config.writeTimeoutMs as number))
      : this.readTimeoutMs;
    this.maxRetries = Number.isFinite(config.maxRetries)
      ? Math.max(0, Math.floor(config.maxRetries as number))
      : DEFAULT_MAX_RETRIES;
    this.writeMaxRetries = Number.isFinite(config.writeMaxRetries)
      ? Math.max(0, Math.floor(config.writeMaxRetries as number))
      : this.maxRetries;
    this.retryBaseDelayMs = Number.isFinite(config.retryBaseDelayMs)
      ? Math.max(0, Math.floor(config.retryBaseDelayMs as number))
      : DEFAULT_RETRY_BASE_DELAY_MS;
    this.fetchImpl = fetchImpl;

    // Bind operations
    const writeConfig = {
      writeTimeoutMs: this.writeTimeoutMs,
      writeMaxRetries: this.writeMaxRetries,
    };
    this.addMemory = createStoreOperation(this.request.bind(this), writeConfig);
    this.updateMemory = createUpdateOperation(this.request.bind(this), writeConfig);
    this.searchMemories = createSearchOperation(this.request.bind(this), this.requestV2.bind(this));
    this.listMemories = createListOperation(this.request.bind(this), this.requestV2.bind(this));
    this.getMemory = createGetOperation(this.request.bind(this));
    this.getMemoryHistory = createGetHistoryOperation(this.request.bind(this));
    this.deleteMemory = createDeleteOperation(this.request.bind(this), writeConfig);
    this.deleteMemoriesByFilter = createDeleteByFilterOperation(
      this.request.bind(this),
      writeConfig,
    );
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
    options?: RequestOptions,
  ): Promise<unknown> {
    return this.requestInternal(this.apiPath, path, init, options);
  }

  private async requestInternal(
    apiPath: string,
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
    },
    options?: RequestOptions,
  ): Promise<unknown> {
    let lastError: unknown;
    const timeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(100, Math.floor(options?.timeoutMs as number))
      : this.readTimeoutMs;
    const retryOnTimeout = options?.retryOnTimeout === true;
    const maxRetries = Number.isFinite(options?.maxRetries)
      ? Math.max(0, Math.floor(options?.maxRetries as number))
      : this.maxRetries;
    let maxAttempts = 1 + maxRetries;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(apiPath, path, init, timeoutMs);
      } catch (error) {
        lastError = error;
        if (isMem0RuntimeUnconfiguredError(error)) {
          const synced = await triggerMem0ModelHubSync();
          if (synced) {
            if (attempt + 1 >= maxAttempts) {
              maxAttempts += 1;
            }
            continue;
          }
        }
        const retriesLeft = maxAttempts - attempt - 1;
        const retryableError =
          isTransientHttpError(error) || (retryOnTimeout && isTimeoutError(error));
        if (retriesLeft <= 0 || !retryableError) {
          throw error;
        }
        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  private async requestOnce(
    apiPath: string,
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
    },
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
        const detail = extractErrorDetail(payload);
        const suffix = detail ? `: ${detail}` : '';
        throw new Error(`Mem0 request failed with HTTP ${response.status}${suffix}.`);
      }
      return payload;
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new Error(`Mem0 request timeout after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a Mem0 client from configuration
 */
export function createMem0Client(
  config: Mem0ClientConfig,
  fetchImpl: typeof fetch = fetch,
): Mem0Client {
  if (!config.baseUrl || !config.baseUrl.trim()) {
    throw new Error('Mem0 baseUrl is required.');
  }
  return new HttpMem0Client(config, fetchImpl);
}

/**
 * Create a Mem0 client from environment variables
 */
export function createMem0ClientFromEnv(
  env: EnvLike = process.env as EnvLike,
  fetchImpl: typeof fetch = fetch,
): Mem0Client | null {
  const nodeEnv = String(env.NODE_ENV || '')
    .trim()
    .toLowerCase();
  const isProduction = nodeEnv === 'production';
  const provider = String(env.MEMORY_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (isProduction && provider !== 'mem0') {
    throw new Error('Invalid memory configuration: production requires MEMORY_PROVIDER=mem0.');
  }
  if (provider && provider !== 'mem0') return null;

  const baseUrl = String(env.MEM0_BASE_URL || '').trim();
  const apiKey = String(env.MEM0_API_KEY || '').trim();
  if (provider === 'mem0' && !baseUrl) {
    throw new Error(
      'Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0.',
    );
  }
  if (provider === 'mem0' && !apiKey) {
    throw new Error(
      'Invalid memory configuration: MEM0_API_KEY is required when MEMORY_PROVIDER=mem0.',
    );
  }
  if (!baseUrl) return null;

  const timeoutRaw = Number(env.MEM0_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(100, Math.floor(timeoutRaw))
    : DEFAULT_TIMEOUT_MS;
  const readTimeoutRaw = Number(env.MEM0_READ_TIMEOUT_MS ?? timeoutMs);
  const readTimeoutMs = Number.isFinite(readTimeoutRaw)
    ? Math.max(100, Math.floor(readTimeoutRaw))
    : timeoutMs;
  const writeTimeoutRaw = Number(env.MEM0_WRITE_TIMEOUT_MS ?? readTimeoutMs);
  const writeTimeoutMs = Number.isFinite(writeTimeoutRaw)
    ? Math.max(100, Math.floor(writeTimeoutRaw))
    : readTimeoutMs;

  const maxRetriesRaw = Number(env.MEM0_MAX_RETRIES ?? 3);
  const maxRetries = Number.isFinite(maxRetriesRaw) ? Math.max(0, Math.floor(maxRetriesRaw)) : 3;
  const writeMaxRetriesRaw = Number(env.MEM0_WRITE_MAX_RETRIES ?? 1);
  const writeMaxRetries = Number.isFinite(writeMaxRetriesRaw)
    ? Math.max(0, Math.floor(writeMaxRetriesRaw))
    : 1;

  const retryDelayRaw = Number(env.MEM0_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const retryBaseDelayMs = Number.isFinite(retryDelayRaw)
    ? Math.max(0, Math.floor(retryDelayRaw))
    : DEFAULT_RETRY_BASE_DELAY_MS;

  return createMem0Client(
    {
      baseUrl,
      apiKey: apiKey || undefined,
      apiPath: String(env.MEM0_API_PATH || '/v1').trim() || '/v1',
      timeoutMs,
      readTimeoutMs,
      writeTimeoutMs,
      maxRetries,
      writeMaxRetries,
      retryBaseDelayMs,
    },
    fetchImpl,
  );
}

// Export the client class for advanced use cases
export { HttpMem0Client };
