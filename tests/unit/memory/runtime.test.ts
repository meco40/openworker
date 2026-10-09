import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mem0Client } from '@/server/memory/mem0';
import {
  assertMemoryRuntimeConfiguration,
  assertMemoryRuntimeReady,
  ensureMemoryRuntimeReadyForStartup,
  getMemoryProviderKind,
  getMemoryService,
  getMemoryRuntimeReadyState,
  getMemoryServiceIfReady,
  MemoryRuntimeUnavailableError,
  recoverMemoryRuntimeNow,
  setMemoryRuntimeReadyStateForTests,
} from '@/server/memory/runtime';

type GlobalSingletons = typeof globalThis & {
  __mem0Client?: Mem0Client | null;
  __memoryRuntimeReady?: boolean;
  __memoryService?: unknown;
};

const globals = globalThis as GlobalSingletons;
const originalMem0Client = globals.__mem0Client;
const originalMemoryRuntimeReady = globals.__memoryRuntimeReady;
const originalMemoryService = globals.__memoryService;
const runtimeEnvKeys = [
  'NODE_ENV',
  'MEMORY_PROVIDER',
  'MEMORY_DB_PATH',
  'MEM0_BASE_URL',
  'MEM0_API_KEY',
  'WORLD_MODEL_MODE',
] as const;
const originalRuntimeEnv = new Map(runtimeEnvKeys.map((key) => [key, process.env[key]]));

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else Reflect.set(process.env, key, value);
}

afterEach(() => {
  globals.__mem0Client = originalMem0Client;
  globals.__memoryService = originalMemoryService;
  setMemoryRuntimeReadyStateForTests(originalMemoryRuntimeReady);
  for (const key of runtimeEnvKeys) {
    setEnv(key, originalRuntimeEnv.get(key));
  }
});

describe('memory runtime configuration', () => {
  it('does not require mem0 configuration outside production', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'development',
        MEMORY_PROVIDER: '',
        MEM0_BASE_URL: '',
      }),
    ).not.toThrow();
    expect(() => assertMemoryRuntimeConfiguration({ MEMORY_PROVIDER: 'sqlite' })).not.toThrow();
  });

  it('requires MEMORY_PROVIDER=mem0 in production', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: '',
        MEM0_BASE_URL: 'http://mem0.local',
      }),
    ).toThrow(/MEMORY_PROVIDER=mem0/i);
  });

  it('requires MEM0_BASE_URL when provider is mem0 in production', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: '',
      }),
    ).toThrow(/MEM0_BASE_URL/i);
  });

  it('requires MEM0_API_KEY when provider is mem0 in production', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: 'http://mem0.local',
        MEM0_API_KEY: '',
      }),
    ).toThrow(/MEM0_API_KEY/i);
  });

  it('accepts valid production memory configuration', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: 'http://mem0.local',
        MEM0_API_KEY: 'mem0_secret',
      }),
    ).not.toThrow();
  });

  it('requires canonical World Model configuration for production Postgres', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'postgres',
        WORLD_MODEL_MODE: 'off',
      }),
    ).toThrow(/WORLD_MODEL_MODE=canonical/i);
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'postgres',
        WORLD_MODEL_MODE: 'shadow',
      }),
    ).toThrow(/WORLD_MODEL_MODE=canonical/i);
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: ' Postgres ',
        WORLD_MODEL_MODE: 'canonical',
      }),
    ).not.toThrow();
  });

  it('rejects SQLite as a production provider', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({ NODE_ENV: 'production', MEMORY_PROVIDER: 'sqlite' }),
    ).toThrow(/production requires MEMORY_PROVIDER=postgres/i);
  });

  it('selects and memoizes the configured Postgres, SQLite, and Mem0 clients', () => {
    setEnv('NODE_ENV', 'test');
    globals.__mem0Client = undefined;
    process.env.MEMORY_PROVIDER = 'world-model';
    expect(getMemoryProviderKind()).toBe('postgres');
    expect(getMemoryProviderKind()).toBe('postgres');

    globals.__mem0Client = undefined;
    process.env.MEMORY_PROVIDER = 'sqlite';
    process.env.MEMORY_DB_PATH = ':memory:';
    expect(getMemoryProviderKind()).toBe('sqlite');

    globals.__mem0Client = undefined;
    process.env.MEMORY_PROVIDER = 'mem0';
    process.env.MEM0_BASE_URL = 'http://127.0.0.1:8010';
    process.env.MEM0_API_KEY = 'local-test-token';
    expect(getMemoryProviderKind()).toBe('mem0');

    globals.__mem0Client = undefined;
    process.env.MEMORY_PROVIDER = '';
    process.env.WORLD_MODEL_MODE = 'canonical';
    expect(getMemoryProviderKind()).toBe('postgres');

    globals.__mem0Client = undefined;
    process.env.WORLD_MODEL_MODE = 'off';
    expect(getMemoryProviderKind()).toBe('mem0');
  });

  it('rejects an unavailable or unsupported memory client', () => {
    setEnv('NODE_ENV', 'test');
    globals.__mem0Client = null;
    expect(() => getMemoryProviderKind()).toThrow(/memory client unavailable/i);

    globals.__mem0Client = undefined;
    process.env.MEMORY_PROVIDER = 'unsupported';
    expect(() => getMemoryProviderKind()).toThrow(/memory client unavailable/i);
  });

  it('verifies mem0 connectivity through listMemories', async () => {
    const listMemories = vi.fn().mockResolvedValue({
      memories: [],
      total: 0,
      page: 1,
      pageSize: 1,
    });
    globals.__mem0Client = {
      listMemories,
    } as unknown as Mem0Client;

    await expect(assertMemoryRuntimeReady()).resolves.toBeUndefined();
    expect(getMemoryRuntimeReadyState()).toBe(true);
    expect(listMemories).toHaveBeenCalledWith({
      userId: 'memory-runtime-probe',
      personaId: 'memory-runtime-probe',
      page: 1,
      pageSize: 1,
    });
  });

  it('throws a clear error when mem0 connectivity probe fails', async () => {
    globals.__mem0Client = {
      listMemories: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Mem0Client;

    await expect(assertMemoryRuntimeReady()).rejects.toThrow(/connectivity check failed/i);
    expect(getMemoryRuntimeReadyState()).toBe(false);
  });

  it('includes non-Error probe failures in the connectivity message', async () => {
    globals.__mem0Client = {
      listMemories: vi.fn().mockRejectedValue('provider offline'),
    } as unknown as Mem0Client;

    await expect(assertMemoryRuntimeReady()).rejects.toThrow(
      'Memory provider connectivity check failed: provider offline',
    );
  });

  it('continues startup in development when mem0 stays unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globals.__mem0Client = {
      listMemories: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Mem0Client;

    await expect(
      ensureMemoryRuntimeReadyForStartup({
        component: 'gateway',
        env: { NODE_ENV: 'development' },
        retries: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(false);

    expect(getMemoryRuntimeReadyState()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway continuing without confirmed memory provider readiness'),
    );
  });

  it('retries and throws in production when mem0 stays unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listMemories = vi.fn().mockRejectedValue(new Error('connection refused'));
    globals.__mem0Client = {
      listMemories,
    } as unknown as Mem0Client;

    await expect(
      ensureMemoryRuntimeReadyForStartup({
        component: 'scheduler',
        env: { NODE_ENV: 'production' },
        retries: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/connectivity check failed/i);

    expect(listMemories).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scheduler memory provider readiness probe failed'),
    );
  });

  it('returns true once a retry succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const listMemories = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValue({
        memories: [],
        total: 0,
        page: 1,
        pageSize: 1,
      });
    globals.__mem0Client = {
      listMemories,
    } as unknown as Mem0Client;

    await expect(
      ensureMemoryRuntimeReadyForStartup({
        component: 'gateway',
        env: { NODE_ENV: 'development' },
        retries: 2,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(true);

    expect(getMemoryRuntimeReadyState()).toBe(true);
    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway memory provider readiness probe failed'),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway memory provider connectivity ready after retry 1/2'),
    );
  });

  it('uses startup defaults when no options are supplied', async () => {
    setEnv('NODE_ENV', 'development');
    globals.__mem0Client = {
      listMemories: vi.fn().mockResolvedValue({
        memories: [],
        total: 0,
        page: 1,
        pageSize: 1,
      }),
    } as unknown as Mem0Client;

    await expect(ensureMemoryRuntimeReadyForStartup()).resolves.toBe(true);
  });

  it('reports non-Error startup failures and continues in development', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globals.__mem0Client = {
      listMemories: vi.fn().mockRejectedValue('provider offline'),
    } as unknown as Mem0Client;

    await expect(
      ensureMemoryRuntimeReadyForStartup({
        component: 'scheduler',
        env: { NODE_ENV: 'development' },
        retries: 0,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provider offline'));
  });

  it('uses the production retry default and fails closed after all attempts', async () => {
    setEnv('NODE_ENV', 'test');
    const listMemories = vi.fn().mockRejectedValue(new Error('connection refused'));
    globals.__mem0Client = { listMemories } as unknown as Mem0Client;

    await expect(
      ensureMemoryRuntimeReadyForStartup({
        component: 'scheduler',
        env: { NODE_ENV: 'production' },
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/connectivity check failed/i);

    expect(listMemories).toHaveBeenCalledTimes(3);
  });

  it('returns null from getMemoryServiceIfReady when runtime is marked degraded', () => {
    setMemoryRuntimeReadyStateForTests(false);

    expect(getMemoryServiceIfReady()).toBeNull();
  });

  it('throws while degraded and avoids scheduling duplicate recovery timers', () => {
    setMemoryRuntimeReadyStateForTests(false);

    expect(() => getMemoryService()).toThrow(MemoryRuntimeUnavailableError);
    const timer = globals.__memoryRuntimeRecoveryTimer;
    expect(timer).toBeDefined();
    expect(getMemoryServiceIfReady()).toBeNull();
    expect(globals.__memoryRuntimeRecoveryTimer).toBe(timer);
  });

  it('returns null for an unset ready state and memoizes the service when healthy', () => {
    setMemoryRuntimeReadyStateForTests(undefined);
    expect(getMemoryRuntimeReadyState()).toBeNull();
    globals.__mem0Client = {
      provider: 'sqlite',
      listMemories: vi.fn(),
    } as unknown as Mem0Client;
    globals.__memoryService = undefined;

    const first = getMemoryService();
    expect(getMemoryService()).toBe(first);
  });

  it('recovers a degraded runtime after Mem0 becomes reachable without a restart', async () => {
    setMemoryRuntimeReadyStateForTests(false);
    const listMemories = vi.fn().mockResolvedValue({
      memories: [],
      total: 0,
      page: 1,
      pageSize: 1,
    });
    globals.__mem0Client = { listMemories } as unknown as Mem0Client;

    await expect(recoverMemoryRuntimeNow()).resolves.toBe(true);
    expect(getMemoryRuntimeReadyState()).toBe(true);
    expect(getMemoryServiceIfReady()).not.toBeNull();
    expect(listMemories).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight recovery probe between concurrent callers', async () => {
    setMemoryRuntimeReadyStateForTests(false);
    let releaseProbe!: (value: {
      memories: [];
      total: number;
      page: number;
      pageSize: number;
    }) => void;
    const listMemories = vi.fn(
      () =>
        new Promise<{ memories: []; total: number; page: number; pageSize: number }>((resolve) => {
          releaseProbe = resolve;
        }),
    );
    globals.__mem0Client = { listMemories } as unknown as Mem0Client;

    const first = recoverMemoryRuntimeNow();
    const second = recoverMemoryRuntimeNow();
    expect(listMemories).toHaveBeenCalledTimes(1);
    releaseProbe({ memories: [], total: 0, page: 1, pageSize: 1 });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
