import { describe, expect, it, vi } from 'vitest';
import { createMem0ClientFromEnv } from '@/server/memory/mem0';
import { registerMem0ClientCleanup } from './mem0-client.harness';

describe('mem0Client', () => {
  registerMem0ClientCleanup();
  it('creates a client from env only when provider is mem0 and base url exists', () => {
    const fetchMock = vi.fn();

    const disabled = createMem0ClientFromEnv(
      {
        MEMORY_PROVIDER: 'disabled',
        MEM0_BASE_URL: 'http://mem0.local',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(disabled).toBeNull();

    const implicit = createMem0ClientFromEnv(
      {
        MEM0_BASE_URL: 'http://mem0.local',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(implicit).not.toBeNull();

    const enabled = createMem0ClientFromEnv(
      {
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: 'http://mem0.local',
        MEM0_API_KEY: 'mem0_secret',
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(enabled).not.toBeNull();
  });

  it('throws for explicit mem0 provider without base url', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          MEMORY_PROVIDER: 'mem0',
          MEM0_BASE_URL: '',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEM0_BASE_URL/i);
  });

  it('throws for explicit mem0 provider without api key', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          MEMORY_PROVIDER: 'mem0',
          MEM0_BASE_URL: 'http://mem0.local',
          MEM0_API_KEY: '',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEM0_API_KEY/i);
  });

  it('throws in production when MEMORY_PROVIDER is not mem0', () => {
    const fetchMock = vi.fn();
    expect(() =>
      createMem0ClientFromEnv(
        {
          NODE_ENV: 'production',
          MEMORY_PROVIDER: '',
          MEM0_BASE_URL: 'http://mem0.local',
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).toThrow(/MEMORY_PROVIDER=mem0/i);
  });
});
