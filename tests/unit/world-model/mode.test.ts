import { describe, expect, it } from 'vitest';

import {
  isWorldModelActive,
  isWorldModelCanonical,
  isWorldModelRequired,
  modeFromLegacyFlags,
  parseWorldModelMode,
} from '@/server/world-model/mode';

describe('world-model mode', () => {
  it('parses the four modes', () => {
    expect(parseWorldModelMode('off')).toBe('off');
    expect(parseWorldModelMode('shadow')).toBe('shadow');
    expect(parseWorldModelMode('required')).toBe('required');
    expect(parseWorldModelMode('canonical')).toBe('canonical');
  });

  it('defaults to off for unknown/empty values', () => {
    expect(parseWorldModelMode('')).toBe('off');
    expect(parseWorldModelMode('bogus')).toBe('off');
  });

  it('treats unknown input leniently', () => {
    expect(parseWorldModelMode('unknown_mode')).toBe('off');
  });

  it('classifies modes by activity and requirement', () => {
    expect(isWorldModelActive('off')).toBe(false);
    expect(isWorldModelActive('shadow')).toBe(true);
    expect(isWorldModelRequired('required')).toBe(true);
    expect(isWorldModelRequired('canonical')).toBe(true);
    expect(isWorldModelCanonical('canonical')).toBe(true);
    expect(isWorldModelCanonical('shadow')).toBe(false);
  });

  it('maps legacy flags to a mode', () => {
    expect(
      modeFromLegacyFlags({
        enabled: true,
        ingestionBridgeEnabled: true,
        mem0PreferencesOnly: false,
      }),
    ).toBe('shadow');
    expect(
      modeFromLegacyFlags({
        enabled: true,
        ingestionBridgeEnabled: true,
        mem0PreferencesOnly: true,
      }),
    ).toBe('canonical');
    expect(
      modeFromLegacyFlags({
        enabled: false,
        ingestionBridgeEnabled: false,
        mem0PreferencesOnly: false,
      }),
    ).toBe('off');
  });
});
