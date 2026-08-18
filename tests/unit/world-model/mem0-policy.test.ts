import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mem0 policy (Phase 6)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats mem0 as primary memory by default', async () => {
    const { isMem0PrimaryMemory, isMem0PreferencesOnly } =
      await import('@/server/world-model/mem0Policy');
    expect(isMem0PrimaryMemory()).toBe(true);
    expect(isMem0PreferencesOnly()).toBe(false);
  });

  it('demotes mem0 when WORLD_MODEL_MEM0_PREFERENCES_ONLY=true', async () => {
    vi.stubEnv('WORLD_MODEL_MEM0_PREFERENCES_ONLY', 'true');
    const { isMem0PrimaryMemory, isMem0PreferencesOnly } =
      await import('@/server/world-model/mem0Policy');
    expect(isMem0PrimaryMemory()).toBe(false);
    expect(isMem0PreferencesOnly()).toBe(true);
  });
});
