import { MemoryService } from '@/server/memory/service';
import type { Mem0Client } from '@/server/memory/mem0';
import { createMem0ClientFromEnv } from '@/server/memory/mem0';
import { SqliteMemoryClient } from '@/server/memory/sqliteMemoryClient';
import { PostgresMemoryClient } from '@/server/memory/postgresMemoryClient';
import { resolveWorldModelConfig } from '@/server/world-model/config';

declare global {
  var __memoryService: MemoryService | undefined;
  var __mem0Client: Mem0Client | null | undefined;
  var __memoryRuntimeReady: boolean | undefined;
  var __memoryRuntimeRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  var __memoryRuntimeRecoveryInFlight: Promise<boolean> | undefined;
  var __memoryRuntimeRecoveryAttempt: number | undefined;
}

type EnvLike = Record<string, string | undefined>;
const MEM0_RUNTIME_PROBE_USER_ID = 'mem0-runtime-probe';
const MEM0_RUNTIME_PROBE_PERSONA_ID = 'mem0-runtime-probe';
const DEFAULT_STARTUP_RETRY_DELAY_MS = 1500;
const DEFAULT_RECOVERY_RETRY_DELAY_MS = 5000;
const MAX_RECOVERY_RETRY_DELAY_MS = 60_000;

function configuredProvider(env: EnvLike = process.env as EnvLike): 'postgres' | 'mem0' | 'sqlite' {
  const explicit = String(env.MEMORY_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (explicit === 'postgres' || explicit === 'world-model' || explicit === 'world_model') {
    return 'postgres';
  }
  if (explicit === 'sqlite') return 'sqlite';
  if (explicit === 'mem0') return 'mem0';
  return resolveWorldModelConfig(env).mode === 'canonical' ? 'postgres' : 'mem0';
}

function isProductionEnv(env: EnvLike = process.env as EnvLike): boolean {
  return (
    String(env.NODE_ENV || '')
      .trim()
      .toLowerCase() === 'production'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setMemoryRuntimeReadyState(ready: boolean | undefined): void {
  globalThis.__memoryRuntimeReady = ready;
  if (ready === true || ready === undefined) {
    if (globalThis.__memoryRuntimeRecoveryTimer) {
      clearTimeout(globalThis.__memoryRuntimeRecoveryTimer);
    }
    globalThis.__memoryRuntimeRecoveryTimer = undefined;
    globalThis.__memoryRuntimeRecoveryAttempt = 0;
  }
}

function scheduleMemoryRuntimeRecoveryProbe(): void {
  if (globalThis.__memoryRuntimeReady !== false) return;
  if (globalThis.__memoryRuntimeRecoveryTimer || globalThis.__memoryRuntimeRecoveryInFlight) return;

  const attempt = Math.max(0, globalThis.__memoryRuntimeRecoveryAttempt || 0);
  const delayMs = Math.min(
    MAX_RECOVERY_RETRY_DELAY_MS,
    DEFAULT_RECOVERY_RETRY_DELAY_MS * Math.pow(2, attempt),
  );
  globalThis.__memoryRuntimeRecoveryAttempt = attempt + 1;
  const timer = setTimeout(() => {
    globalThis.__memoryRuntimeRecoveryTimer = undefined;
    void recoverMemoryRuntimeNow();
  }, delayMs);
  // A degraded probe must never keep a CLI/test process alive by itself.
  timer.unref?.();
  globalThis.__memoryRuntimeRecoveryTimer = timer;
}

export function assertMemoryRuntimeConfiguration(env: EnvLike = process.env as EnvLike): void {
  if (!isProductionEnv(env)) return;

  const provider = configuredProvider(env);
  if (provider === 'postgres') {
    const worldModel = resolveWorldModelConfig(env);
    if (!worldModel.enabled || worldModel.mode !== 'canonical') {
      throw new Error(
        'Invalid memory configuration: MEMORY_PROVIDER=postgres requires WORLD_MODEL_MODE=canonical and an enabled World Model.',
      );
    }
    return;
  }
  if (provider !== 'mem0') {
    throw new Error(
      'Invalid memory configuration: production requires MEMORY_PROVIDER=postgres (canonical) or explicit MEMORY_PROVIDER=mem0 (legacy).',
    );
  }

  const baseUrl = String(env.MEM0_BASE_URL || '').trim();
  if (!baseUrl) {
    throw new Error(
      'Invalid memory configuration: MEM0_BASE_URL is required when MEMORY_PROVIDER=mem0.',
    );
  }

  const apiKey = String(env.MEM0_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Invalid memory configuration: MEM0_API_KEY is required when MEMORY_PROVIDER=mem0.',
    );
  }
}

function resolveMemoryClient(): Mem0Client | null {
  assertMemoryRuntimeConfiguration();
  if (globalThis.__mem0Client === undefined) {
    const provider = configuredProvider();
    globalThis.__mem0Client =
      provider === 'postgres'
        ? new PostgresMemoryClient()
        : provider === 'sqlite'
          ? new SqliteMemoryClient()
          : createMem0ClientFromEnv();
  }
  return globalThis.__mem0Client ?? null;
}

export class MemoryRuntimeUnavailableError extends Error {
  constructor(message = 'Memory runtime unavailable: configured provider is not ready.') {
    super(message);
    this.name = 'MemoryRuntimeUnavailableError';
  }
}

function getRequiredMemoryClient(): Mem0Client {
  const client = resolveMemoryClient();
  if (!client) {
    throw new Error(
      'Invalid memory configuration: memory client unavailable. Set MEMORY_PROVIDER=postgres, mem0, or sqlite.',
    );
  }
  return client;
}

export function getMemoryService(): MemoryService {
  if (globalThis.__memoryRuntimeReady === false) {
    scheduleMemoryRuntimeRecoveryProbe();
    throw new MemoryRuntimeUnavailableError();
  }
  if (!globalThis.__memoryService) {
    globalThis.__memoryService = new MemoryService(getRequiredMemoryClient());
  }
  return globalThis.__memoryService;
}

export function getMemoryRuntimeReadyState(): boolean | null {
  return typeof globalThis.__memoryRuntimeReady === 'boolean'
    ? globalThis.__memoryRuntimeReady
    : null;
}

export function getMemoryServiceIfReady(): MemoryService | null {
  if (globalThis.__memoryRuntimeReady === false) {
    scheduleMemoryRuntimeRecoveryProbe();
    return null;
  }
  return getMemoryService();
}

export function getMemoryProviderKind(): 'postgres' | 'mem0' | 'sqlite' {
  return getRequiredMemoryClient().provider ?? 'mem0';
}

export async function assertMemoryRuntimeReady(): Promise<void> {
  const client = getRequiredMemoryClient();
  try {
    await client.listMemories({
      userId: MEM0_RUNTIME_PROBE_USER_ID,
      personaId: MEM0_RUNTIME_PROBE_PERSONA_ID,
      page: 1,
      pageSize: 1,
    });
    setMemoryRuntimeReadyState(true);
  } catch (error) {
    setMemoryRuntimeReadyState(false);
    scheduleMemoryRuntimeRecoveryProbe();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Memory provider connectivity check failed: ${message}`);
  }
}

export async function ensureMemoryRuntimeReadyForStartup(options?: {
  component: 'gateway' | 'scheduler';
  env?: EnvLike;
  retries?: number;
  retryDelayMs?: number;
}): Promise<boolean> {
  const env = options?.env ?? (process.env as EnvLike);
  const component = options?.component ?? 'gateway';
  const retries = Math.max(0, Math.floor(options?.retries ?? (isProductionEnv(env) ? 2 : 4)));
  const retryDelayMs = Math.max(
    0,
    Math.floor(options?.retryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS),
  );
  const required = isProductionEnv(env);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await assertMemoryRuntimeReady();
      if (attempt > 0) {
        console.info(
          `[memory-runtime] ${component} memory provider connectivity ready after retry ${attempt}/${retries}`,
        );
      }
      setMemoryRuntimeReadyState(true);
      return true;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const attemptLabel = `${attempt + 1}/${retries + 1}`;
      if (attempt < retries) {
        console.warn(
          `[memory-runtime] ${component} memory provider readiness probe failed (${attemptLabel}): ${message}. Retrying in ${retryDelayMs}ms...`,
        );
        await sleep(retryDelayMs);
        continue;
      }

      if (required) {
        throw error;
      }

      console.warn(
        `[memory-runtime] ${component} continuing without confirmed memory provider readiness after ${attemptLabel}: ${message}`,
      );
      setMemoryRuntimeReadyState(false);
      scheduleMemoryRuntimeRecoveryProbe();
      return false;
    }
  }

  if (required && lastError) {
    throw lastError;
  }
  return false;
}

export function setMemoryRuntimeReadyStateForTests(ready: boolean | undefined): void {
  setMemoryRuntimeReadyState(ready);
}

/**
 * Probe a degraded runtime immediately. The background timer uses the same
 * path, while callers and health checks can use this to recover without a
 * process restart.
 */
export async function recoverMemoryRuntimeNow(): Promise<boolean> {
  if (globalThis.__memoryRuntimeRecoveryInFlight) {
    return globalThis.__memoryRuntimeRecoveryInFlight;
  }

  const probe = (async () => {
    try {
      await assertMemoryRuntimeReady();
      return true;
    } catch {
      scheduleMemoryRuntimeRecoveryProbe();
      return false;
    }
  })();
  globalThis.__memoryRuntimeRecoveryInFlight = probe;
  try {
    return await probe;
  } finally {
    if (globalThis.__memoryRuntimeRecoveryInFlight === probe) {
      globalThis.__memoryRuntimeRecoveryInFlight = undefined;
    }
  }
}
