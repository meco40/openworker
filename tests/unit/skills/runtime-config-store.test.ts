import { beforeEach, describe, expect, it } from 'vitest';
import {
  SkillRuntimeConfigStore,
  getRuntimeConfigValue,
  resolveSkillRuntimeConfigStatus,
} from '../../../src/server/skills/runtimeConfig';

describe('SkillRuntimeConfigStore', () => {
  let store: SkillRuntimeConfigStore;

  beforeEach(() => {
    store = new SkillRuntimeConfigStore(':memory:');
  });

  it('prefers stored values over env fallback', () => {
    store.setValue('vision.gemini_api_key', 'store-key-1234');

    const status = resolveSkillRuntimeConfigStatus(store, {
      GEMINI_API_KEY: 'env-key-5678',
    }).find((item) => item.id === 'vision.gemini_api_key');

    expect(status?.configured).toBe(true);
    expect(status?.source).toBe('store');
    expect(status?.maskedValue).not.toContain('store-key-1234');
    expect(
      getRuntimeConfigValue('vision.gemini_api_key', {
        store,
        env: { GEMINI_API_KEY: 'env-key-5678' },
      }),
    ).toBe('store-key-1234');
  });

  it('falls back to env when no stored value exists', () => {
    const status = resolveSkillRuntimeConfigStatus(store, {
      GEMINI_API_KEY: 'env-key-5678',
    }).find((item) => item.id === 'vision.gemini_api_key');

    expect(status?.configured).toBe(true);
    expect(status?.source).toBe('env');
    expect(status?.maskedValue).not.toContain('env-key-5678');
    expect(
      getRuntimeConfigValue('vision.gemini_api_key', {
        store,
        env: { GEMINI_API_KEY: 'env-key-5678' },
      }),
    ).toBe('env-key-5678');
  });

  it('deletes stored config values', () => {
    store.setValue('vision.gemini_api_key', 'store-key-1234');
    expect(getRuntimeConfigValue('vision.gemini_api_key', { store, env: {} })).toBe(
      'store-key-1234',
    );

    store.deleteValue('vision.gemini_api_key');
    expect(getRuntimeConfigValue('vision.gemini_api_key', { store, env: {} })).toBeNull();
  });
});
