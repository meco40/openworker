import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mem0Client } from '@/server/memory/mem0';
import {
  assertMemoryRuntimeConfiguration,
  assertMemoryRuntimeReady,
  ensureMemoryRuntimeReadyForStartup,
  getMemoryRuntimeReadyState,
  getMemoryServiceIfReady,
  recoverMemoryRuntimeNow,
  setMemoryRuntimeReadyStateForTests,
} from '@/server/memory/runtime';

type GlobalSingletons = typeof globalThis & {
  __mem0Client?: Mem0Client | null;
  __memoryRuntimeReady?: boolean;
};

const globals = globalThis as GlobalSingletons;
const originalMem0Client = globals.__mem0Client;
const originalMemoryRuntimeReady = globals.__memoryRuntimeReady;

afterEach(() => {
  globals.__mem0Client = originalMem0Client;
  setMemoryRuntimeReadyStateForTests(originalMemoryRuntimeReady);
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
      userId: 'mem0-runtime-probe',
      personaId: 'mem0-runtime-probe',
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
      expect.stringContaining('gateway continuing without confirmed Mem0 readiness'),
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
      expect.stringContaining('scheduler Mem0 readiness probe failed'),
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
      expect.stringContaining('gateway Mem0 readiness probe failed'),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway Mem0 connectivity ready after retry 1/2'),
    );
  });

  it('returns null from getMemoryServiceIfReady when runtime is marked degraded', () => {
    setMemoryRuntimeReadyStateForTests(false);

    expect(getMemoryServiceIfReady()).toBeNull();
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
});
