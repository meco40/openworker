import { describe, expect, it } from 'vitest';

import {
  CHANNEL_CAPABILITIES,
  normalizeChannelKey,
} from '../../../src/server/channels/adapters/capabilities';

describe('channel adapter contracts', () => {
  it('normalizes known channel keys and exposes capabilities', () => {
    expect(normalizeChannelKey('telegram')).toBe('telegram');
    expect(CHANNEL_CAPABILITIES.telegram.supportsInbound).toBe(true);
    expect(CHANNEL_CAPABILITIES.webchat.supportsOutbound).toBe(false);
  });

  it('normalizes channel keys case-insensitively and trims spaces', () => {
    expect(normalizeChannelKey('  DisCord ')).toBe('discord');
  });

  it('returns null for unknown channels', () => {
    expect(normalizeChannelKey('unknown')).toBeNull();
  });
});
