import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mem0Client } from '@/server/memory/mem0';
import {
  assertMemoryRuntimeConfiguration,
  assertMemoryRuntimeReady,
} from '@/server/memory/runtime';

type GlobalSingletons = typeof globalThis & {
  __mem0Client?: Mem0Client | null;
};

const globals = globalThis as GlobalSingletons;
const originalMem0Client = globals.__mem0Client;

afterEach(() => {
  globals.__mem0Client = originalMem0Client;
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
  });
});
