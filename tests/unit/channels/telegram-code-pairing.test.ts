import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  beginTelegramCodePairing,
  confirmTelegramPairingCode,
  ensureTelegramPairingCode,
  isTelegramChatAuthorized,
} from '../../../src/server/channels/pairing/telegramCodePairing';

const NOW = new Date('2026-02-10T08:00:00.000Z');

describe('telegram code pairing', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    beginTelegramCodePairing();
  });

  it('issues a six-digit code for first incoming chat', () => {
    const result = ensureTelegramPairingCode('chat-1', NOW);

    expect(result.kind).toBe('issued');
    if (result.kind !== 'issued') {
      throw new Error('expected issued result');
    }

    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.reused).toBe(false);
  });

  it('reuses active code when same chat messages again', () => {
    const first = ensureTelegramPairingCode('chat-1', NOW);
    const second = ensureTelegramPairingCode('chat-1', new Date('2026-02-10T08:01:00.000Z'));

    expect(first.kind).toBe('issued');
    expect(second.kind).toBe('issued');
    if (first.kind !== 'issued' || second.kind !== 'issued') {
      throw new Error('expected issued result');
    }

    expect(second.code).toBe(first.code);
    expect(second.reused).toBe(true);
  });

  it('blocks a different chat while pending code exists', () => {
    ensureTelegramPairingCode('chat-1', NOW);
    const blocked = ensureTelegramPairingCode('chat-2', new Date('2026-02-10T08:02:00.000Z'));

    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') {
      throw new Error('expected blocked result');
    }

    expect(blocked.pendingChatId).toBe('chat-1');
  });

  it('confirms the code and authorizes that chat', () => {
    const issued = ensureTelegramPairingCode('chat-42', NOW);
    if (issued.kind !== 'issued') {
      throw new Error('expected issued result');
    }

    const wrong = confirmTelegramPairingCode('000000', new Date('2026-02-10T08:03:00.000Z'));
    expect(wrong.ok).toBe(false);

    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:03:00.000Z'));
    expect(confirmed.ok).toBe(true);
    expect(confirmed.chatId).toBe('chat-42');
    expect(isTelegramChatAuthorized('chat-42')).toBe(true);
  });

  it('does not allow a different chat to hijack an already connected binding', () => {
    const issued = ensureTelegramPairingCode('chat-1', NOW);
    if (issued.kind !== 'issued') {
      throw new Error('expected issued result');
    }
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:03:00.000Z'));
    if (!confirmed.ok) {
      throw new Error('expected successful confirmation');
    }

    const next = ensureTelegramPairingCode('chat-2', new Date('2026-02-10T08:04:00.000Z'));
    expect(next.kind).toBe('already_bound');
    if (next.kind !== 'already_bound') {
      throw new Error('expected already_bound result');
    }
    expect(next.pairedChatId).toBe('chat-1');
    expect(isTelegramChatAuthorized('chat-1')).toBe(true);
    expect(isTelegramChatAuthorized('chat-2')).toBe(false);
  });

  it('rejects expired codes', () => {
    const issued = ensureTelegramPairingCode('chat-99', NOW);
    if (issued.kind !== 'issued') {
      throw new Error('expected issued result');
    }

    const expired = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:20:00.000Z'));
    expect(expired.ok).toBe(false);
    expect(expired.error).toMatch(/expired/i);
    expect(isTelegramChatAuthorized('chat-99')).toBe(false);
  });
});
