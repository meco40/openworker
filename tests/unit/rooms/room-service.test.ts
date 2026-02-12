import { describe, expect, it } from 'vitest';

import { resolveRoomRouting } from '../../../src/server/rooms/service';

describe('Room service routing resolver', () => {
  it('uses member model override when it is active in room profile', () => {
    const resolved = resolveRoomRouting({
      roomProfileId: 'p-office',
      memberModelOverride: 'grok-4',
      activeModelsByProfile: {
        'p-office': ['grok-4', 'gpt-4.1'],
      },
    });

    expect(resolved.profileId).toBe('p-office');
    expect(resolved.model).toBe('grok-4');
    expect(resolved.fallbackUsed).toBe(false);
  });

  it('falls back to room profile when override is not active', () => {
    const resolved = resolveRoomRouting({
      roomProfileId: 'p-office',
      memberModelOverride: 'grok-4',
      activeModelsByProfile: {
        'p-office': ['gpt-4.1'],
      },
    });

    expect(resolved.profileId).toBe('p-office');
    expect(resolved.model).toBe('gpt-4.1');
    expect(resolved.fallbackUsed).toBe(true);
  });

  it('falls back to global p1 when room profile has no active models', () => {
    const resolved = resolveRoomRouting({
      roomProfileId: 'p-office',
      memberModelOverride: null,
      activeModelsByProfile: {
        p1: ['grok-4'],
      },
    });

    expect(resolved.profileId).toBe('p1');
    expect(resolved.model).toBe('grok-4');
    expect(resolved.fallbackUsed).toBe(true);
  });

  it('returns unroutable when no active model exists anywhere', () => {
    const resolved = resolveRoomRouting({
      roomProfileId: 'p-office',
      memberModelOverride: null,
      activeModelsByProfile: {},
    });

    expect(resolved.model).toBeNull();
    expect(resolved.profileId).toBeNull();
    expect(resolved.fallbackUsed).toBe(true);
  });
});
