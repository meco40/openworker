import { beforeEach, describe, expect, it } from 'vitest';

import {
  getAdapter,
  registerAdapter,
  resetAdapterRegistryForTests,
} from '../../../src/server/channels/routing/adapterRegistry';

describe('adapter registry', () => {
  beforeEach(() => {
    resetAdapterRegistryForTests();
  });

  it('registers and resolves adapters by channel', () => {
    const adapter = { channel: 'telegram' as const, send: async () => {} };
    registerAdapter(adapter);

    expect(getAdapter('telegram')).toBe(adapter);
    expect(getAdapter('discord')).toBeUndefined();
  });

  it('replaces adapter when same channel is registered again', () => {
    const first = { channel: 'telegram' as const, send: async () => {} };
    const second = { channel: 'telegram' as const, send: async () => {} };

    registerAdapter(first);
    registerAdapter(second);

    expect(getAdapter('telegram')).toBe(second);
  });
});
