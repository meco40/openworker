import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('assertProductionWorldModelConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.WORLD_MODEL_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does nothing outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WORLD_MODEL_ENABLED', 'true');
    const { assertProductionWorldModelConfig } =
      await import('@/server/world-model/productionGuard');
    expect(() => assertProductionWorldModelConfig()).not.toThrow();
  });

  it('throws in production when enabled without a database url', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WORLD_MODEL_ENABLED', 'true');
    const { assertProductionWorldModelConfig } =
      await import('@/server/world-model/productionGuard');
    expect(() => assertProductionWorldModelConfig()).toThrow(/CANONICAL_DATABASE_URL/);
  });

  it('does not throw in production when disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { assertProductionWorldModelConfig } =
      await import('@/server/world-model/productionGuard');
    expect(() => assertProductionWorldModelConfig()).not.toThrow();
  });

  it('does not throw in production when enabled with CANONICAL_DATABASE_URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WORLD_MODEL_ENABLED', 'true');
    vi.stubEnv('CANONICAL_DATABASE_URL', 'postgresql://c:d@h:2/world');
    const { assertProductionWorldModelConfig } =
      await import('@/server/world-model/productionGuard');
    expect(() => assertProductionWorldModelConfig()).not.toThrow();
  });

  it('rejects the E2E bypass in production even when a canonical URL exists', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WORLD_MODEL_E2E', 'true');
    vi.stubEnv('CANONICAL_DATABASE_URL', 'postgresql://c:d@h:2/world');
    const { assertProductionWorldModelConfig } =
      await import('@/server/world-model/productionGuard');
    expect(() => assertProductionWorldModelConfig()).toThrow(/WORLD_MODEL_E2E/);
  });
});
