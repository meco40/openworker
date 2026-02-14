import { describe, expect, it } from 'vitest';
import { assertMemoryRuntimeConfiguration } from '../../../src/server/memory/runtime';

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

  it('accepts valid production memory configuration', () => {
    expect(() =>
      assertMemoryRuntimeConfiguration({
        NODE_ENV: 'production',
        MEMORY_PROVIDER: 'mem0',
        MEM0_BASE_URL: 'http://mem0.local',
      }),
    ).not.toThrow();
  });
});
