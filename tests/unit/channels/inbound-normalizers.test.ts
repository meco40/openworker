import { describe, expect, it } from 'vitest';

import {
  normalizeDiscordInbound,
  normalizeIMessageInbound,
  normalizeTelegramInbound,
  normalizeWhatsAppInbound,
} from '@/server/channels/inbound/normalizers';

describe('inbound normalizers', () => {
  it('maps telegram webhook payload to unified envelope', () => {
    const envelope = normalizeTelegramInbound({
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: 7, type: 'private' },
        from: { id: 99, username: 'max' },
        text: 'hello',
      },
    });

    expect(envelope).not.toBeNull();
    expect(envelope?.channel).toBe('telegram');
    expect(envelope?.externalChatId).toBe('7');
    expect(envelope?.externalMessageId).toBe('11');
    expect(envelope?.content).toBe('hello');
    expect(envelope?.senderName).toBe('max');
  });

  it('maps discord payload to unified envelope', () => {
    const envelope = normalizeDiscordInbound({
      id: 'm1',
      channel_id: 'c1',
      content: 'ping',
      author: { id: 'u1', username: 'DiscordUser' },
    });

    expect(envelope).not.toBeNull();
    expect(envelope?.channel).toBe('discord');
    expect(envelope?.externalChatId).toBe('c1');
    expect(envelope?.externalMessageId).toBe('m1');
    expect(envelope?.content).toBe('ping');
  });

  it('maps whatsapp bridge payload to unified envelope', () => {
    const envelope = normalizeWhatsAppInbound({
      from: '+491234',
      body: 'Hallo',
      messageId: 'w-1',
      senderName: 'Alice',
    });

    expect(envelope).not.toBeNull();
    expect(envelope?.channel).toBe('whatsapp');
    expect(envelope?.externalChatId).toBe('+491234');
    expect(envelope?.senderName).toBe('Alice');
  });

  it('returns null for empty iMessage payload', () => {
    const envelope = normalizeIMessageInbound({
      chatGuid: 'chat-1',
      text: '   ',
    });
    expect(envelope).toBeNull();
  });
});
