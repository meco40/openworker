import { describe, expect, it } from 'vitest';

import { resolveWorldModelConfig } from '@/server/world-model/config';

describe('world-model config', () => {
  it('defaults to fail-closed (disabled) without env', () => {
    const config = resolveWorldModelConfig({});
    expect(config.enabled).toBe(false);
    expect(config.databaseUrl).toBe('postgresql://clawtest:clawtest@127.0.0.1:5434/clawtest');
    expect(config.e2eEnabled).toBe(false);
  });

  it('parses booleans leniently', () => {
    const config = resolveWorldModelConfig({
      WORLD_MODEL_ENABLED: 'true',
      WORLD_MODEL_INGESTION_BRIDGE: '1',
      WORLD_MODEL_E2E: 'yes',
    });
    expect(config.enabled).toBe(true);
    expect(config.ingestionBridgeEnabled).toBe(true);
    expect(config.e2eEnabled).toBe(true);
  });

  it('prefers CANONICAL_DATABASE_URL over DATABASE_URL and the default', () => {
    const config = resolveWorldModelConfig({
      DATABASE_URL: 'postgresql://a:b@localhost:1/db',
      CANONICAL_DATABASE_URL: 'postgresql://c:d@localhost:2/world',
    });
    expect(config.databaseUrl).toBe('postgresql://c:d@localhost:2/world');
  });

  it('falls back to DATABASE_URL when CANONICAL is unset', () => {
    const config = resolveWorldModelConfig({ DATABASE_URL: 'postgresql://a:b@h:9/db' });
    expect(config.databaseUrl).toBe('postgresql://a:b@h:9/db');
  });

  it('clamps numeric values to sane bounds', () => {
    const config = resolveWorldModelConfig({ WORLD_MODEL_POOL_MAX: '99999' });
    expect(config.poolMax).toBe(100);
  });

  it('uses WORLD_MODEL_MODE as the authoritative rollout switch', () => {
    const shadow = resolveWorldModelConfig({ WORLD_MODEL_MODE: 'shadow' });
    expect(shadow.mode).toBe('shadow');
    expect(shadow.enabled).toBe(true);
    expect(shadow.ingestionBridgeEnabled).toBe(true);
    expect(shadow.mem0PreferencesOnly).toBe(false);

    const canonical = resolveWorldModelConfig({ WORLD_MODEL_MODE: 'canonical' });
    expect(canonical.enabled).toBe(true);
    expect(canonical.ingestionBridgeEnabled).toBe(true);
    expect(canonical.mem0PreferencesOnly).toBe(true);
  });

  it('maps legacy flags to a compatible mode when WORLD_MODEL_MODE is unset', () => {
    const config = resolveWorldModelConfig({
      WORLD_MODEL_ENABLED: 'true',
      WORLD_MODEL_INGESTION_BRIDGE: 'true',
    });
    expect(config.mode).toBe('shadow');
  });
});
