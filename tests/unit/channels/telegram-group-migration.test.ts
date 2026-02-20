import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  beginTelegramCodePairing,
  confirmTelegramPairingCode,
  ensureTelegramPairingCode,
} from '../../../src/server/channels/pairing/telegramCodePairing';
import {
  applyTelegramGroupMigration,
  resolveTelegramGroupMigration,
} from '../../../src/server/channels/telegram/groupMigration';

describe('telegram group migration', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
  });

  it('resolves migrate_to_chat_id events', () => {
    expect(
      resolveTelegramGroupMigration({
        chat: { id: -100111 },
        migrate_to_chat_id: -100222,
      }),
    ).toEqual({
      oldChatId: '-100111',
      newChatId: '-100222',
    });
  });

  it('moves paired chat id to migrated group id', () => {
    const issued = ensureTelegramPairingCode('-100111', new Date('2026-02-19T10:00:00.000Z'));
    if (issued.kind !== 'issued') throw new Error('expected issued pairing code');
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-19T10:01:00.000Z'));
    if (!confirmed.ok) throw new Error('expected confirmation');

    const result = applyTelegramGroupMigration({
      chat: { id: -100111 },
      migrate_to_chat_id: -100222,
    });

    expect(result).toEqual({
      migrated: true,
      oldChatId: '-100111',
      newChatId: '-100222',
    });
  });

  it('moves pending pairing chat id when migration happens before confirmation', () => {
    beginTelegramCodePairing();
    const issued = ensureTelegramPairingCode('-100111', new Date('2026-02-19T10:00:00.000Z'));
    if (issued.kind !== 'issued') throw new Error('expected issued pairing code');

    const result = applyTelegramGroupMigration({
      chat: { id: -100111 },
      migrate_to_chat_id: -100222,
    });

    expect(result.migrated).toBe(true);

    const second = ensureTelegramPairingCode('-100222', new Date('2026-02-19T10:02:00.000Z'));
    expect(second.kind).toBe('issued');
  });
});
