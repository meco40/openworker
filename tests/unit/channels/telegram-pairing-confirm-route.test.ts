import { beforeEach, describe, expect, it } from 'vitest';
import { POST as confirmPost } from '../../../app/api/channels/telegram/pairing/confirm/route';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  beginTelegramCodePairing,
  ensureTelegramPairingCode,
} from '../../../src/server/channels/pairing/telegramCodePairing';

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/channels/telegram/pairing/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('telegram pairing confirm route', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    beginTelegramCodePairing();
  });

  it('rejects missing code', async () => {
    const response = await confirmPost(makeRequest({}));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it('rejects wrong code', async () => {
    ensureTelegramPairingCode('chat-123');

    const response = await confirmPost(makeRequest({ code: '999999' }));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it('marks telegram as connected for valid code', async () => {
    const issued = ensureTelegramPairingCode('chat-123');
    if (issued.kind !== 'issued') {
      throw new Error('expected issued code');
    }

    const response = await confirmPost(makeRequest({ code: issued.code }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('connected');
    expect(json.chatId).toBe('chat-123');
  });
});
