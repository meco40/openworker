import { describe, expect, it } from 'vitest';
import {
  resolveMemoryScopedUserId,
  resolveMemoryUserIdCandidates,
} from '../../../src/server/memory/userScope';

describe('resolveMemoryScopedUserId', () => {
  it('returns legacy-local-user for webchat in single-user mode', () => {
    expect(
      resolveMemoryScopedUserId({
        userId: 'legacy-local-user',
        channelType: 'webchat',
        externalChatId: 'default',
      }),
    ).toBe('legacy-local-user');
  });

  it('returns legacy-local-user for telegram in single-user mode (unified memory)', () => {
    // CRITICAL: In single-user mode, Telegram should share the same memory scope as webchat
    expect(
      resolveMemoryScopedUserId({
        userId: 'legacy-local-user',
        channelType: 'telegram',
        externalChatId: '1527785051',
      }),
    ).toBe('legacy-local-user');
  });

  it('returns legacy-local-user for whatsapp in single-user mode (unified memory)', () => {
    expect(
      resolveMemoryScopedUserId({
        userId: 'legacy-local-user',
        channelType: 'whatsapp',
        externalChatId: '+491234567890',
      }),
    ).toBe('legacy-local-user');
  });

  it('returns authenticated userId directly for webchat', () => {
    expect(
      resolveMemoryScopedUserId({
        userId: 'cm7xyz-user-123',
        channelType: 'webchat',
        externalChatId: 'default',
      }),
    ).toBe('cm7xyz-user-123');
  });

  it('returns authenticated userId for telegram when auth provided', () => {
    expect(
      resolveMemoryScopedUserId({
        userId: 'cm7xyz-user-123',
        channelType: 'telegram',
        externalChatId: '1527785051',
      }),
    ).toBe('cm7xyz-user-123');
  });

  it('returns legacy-local-user when userId is empty/null', () => {
    expect(resolveMemoryScopedUserId({ channelType: 'webchat' })).toBe('legacy-local-user');
    expect(resolveMemoryScopedUserId({ userId: null })).toBe('legacy-local-user');
    expect(resolveMemoryScopedUserId({ userId: '' })).toBe('legacy-local-user');
  });
});

describe('resolveMemoryUserIdCandidates', () => {
  it('returns single legacy-local-user for webchat in single-user mode', () => {
    expect(
      resolveMemoryUserIdCandidates({
        userId: 'legacy-local-user',
        channelType: 'webchat',
        externalChatId: 'default',
      }),
    ).toEqual(['legacy-local-user']);
  });

  it('returns single legacy-local-user for telegram in single-user mode (unified)', () => {
    // In single-user mode, all channels resolve to the same ID — no fallback cascade needed
    expect(
      resolveMemoryUserIdCandidates({
        userId: 'legacy-local-user',
        channelType: 'telegram',
        externalChatId: '1527785051',
      }),
    ).toEqual(['legacy-local-user']);
  });

  it('returns single authenticated userId when auth provided', () => {
    expect(
      resolveMemoryUserIdCandidates({
        userId: 'cm7xyz-user-123',
        channelType: 'telegram',
        externalChatId: '1527785051',
      }),
    ).toEqual(['cm7xyz-user-123']);
  });
});
