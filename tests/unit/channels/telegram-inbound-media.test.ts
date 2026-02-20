import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '../../../types';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  beginTelegramCodePairing,
  confirmTelegramPairingCode,
  ensureTelegramPairingCode,
} from '../../../src/server/channels/pairing/telegramCodePairing';

const handleInbound = vi.fn();
const getOrCreateConversation = vi.fn();
const handleNativeCommand = vi.fn();
const extractTelegramInboundMedia = vi.fn();

vi.mock('../../../src/server/channels/messages/runtime', () => ({
  getMessageService: () => ({
    handleInbound,
    getOrCreateConversation,
  }),
}));

vi.mock('../../../src/server/channels/telegram/modelSelection', () => ({
  handleTelegramNativeCommand: (...args: unknown[]) => handleNativeCommand(...args),
  processTelegramModelCallback: vi.fn(),
}));

vi.mock('../../../src/server/channels/telegram/media', () => ({
  extractTelegramInboundMedia: (...args: unknown[]) => extractTelegramInboundMedia(...args),
  resolveTelegramInboundText: (
    message: { text?: string; caption?: string },
    summary: string | null,
  ) => message.text || message.caption || summary,
}));

describe('telegram inbound media routing', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');

    beginTelegramCodePairing();
    const issued = ensureTelegramPairingCode('123', new Date('2026-02-19T10:00:00.000Z'));
    if (issued.kind !== 'issued') throw new Error('expected issued pairing code');
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-19T10:01:00.000Z'));
    if (!confirmed.ok) throw new Error('expected successful confirmation');

    handleInbound.mockReset();
    getOrCreateConversation.mockReset();
    handleNativeCommand.mockReset();
    extractTelegramInboundMedia.mockReset();

    getOrCreateConversation.mockReturnValue({
      id: 'conv-1',
      userId: 'legacy-local-user',
    });
    handleNativeCommand.mockResolvedValue(false);
    extractTelegramInboundMedia.mockResolvedValue({
      attachments: [
        {
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 6,
          storagePath: 'mock/path/photo.jpg',
        },
      ],
      summaryText: '[Photo]',
    });
  });

  it('routes non-text media messages with generated summary text and attachments', async () => {
    const { processTelegramInboundMessage } = await import(
      '../../../src/server/channels/pairing/telegramInbound'
    );

    const result = await processTelegramInboundMessage({
      message_id: 11,
      chat: { id: 123, type: 'private' },
      from: { id: 22, username: 'alice' },
      photo: [{ file_id: 'photo-1', file_size: 6 }],
    });

    expect(result).toEqual({ handled: true, codeIssued: false });
    expect(handleInbound).toHaveBeenCalledWith(
      ChannelType.TELEGRAM,
      '123',
      '[Photo]',
      'alice',
      '11',
      undefined,
      undefined,
      expect.any(Array),
    );
  });
});
