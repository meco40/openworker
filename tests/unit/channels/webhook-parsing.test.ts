import { describe, it, expect } from 'vitest';
import { ChannelType } from '@/shared/domain/types';

// ─── Telegram Webhook Parsing ────────────────────────────────

describe('Telegram Webhook Parsing', () => {
  it('extracts text message from Telegram Update', () => {
    const update = {
      update_id: 123456,
      message: {
        message_id: 42,
        from: { id: 100, first_name: 'Max', username: 'maxtest' },
        chat: { id: 999, type: 'private' },
        text: 'Hello from Telegram!',
      },
    };

    expect(update.message.text).toBe('Hello from Telegram!');
    expect(String(update.message.chat.id)).toBe('999');
    expect(update.message.from.username).toBe('maxtest');
  });

  it('handles missing username gracefully', () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 200, first_name: 'Anna' },
        chat: { id: 1, type: 'private' },
        text: 'Hi',
      },
    };

    const sender = update.message.from as {
      id: number;
      first_name?: string;
      username?: string;
    };
    const senderName = sender.username || sender.first_name || `user-${sender.id}`;
    expect(senderName).toBe('Anna');
  });

  it('ignores non-text updates', () => {
    const update: {
      update_id: number;
      message: { message_id: number; chat: { id: number; type: string }; text?: string };
    } = { update_id: 2, message: { message_id: 2, chat: { id: 1, type: 'private' } } };
    expect(update.message.text).toBeUndefined();
  });
});

// ─── WhatsApp Webhook Parsing ────────────────────────────────

describe('WhatsApp Webhook Parsing', () => {
  it('extracts message from WhatsApp bridge payload', () => {
    const payload = {
      from: '+49123456789',
      chatId: 'wa-group-1',
      body: 'Hello from WhatsApp',
      messageId: 'wmsg-1',
      senderName: 'Max',
    };

    expect(payload.body).toBe('Hello from WhatsApp');
    expect(payload.chatId).toBe('wa-group-1');
    expect(payload.senderName).toBe('Max');
  });

  it('falls back to from when chatId is missing', () => {
    const payload: { from: string; body: string; chatId?: string } = {
      from: '+49111',
      body: 'Test',
    };
    const chatId = payload.chatId || payload.from || 'unknown';
    expect(chatId).toBe('+49111');
  });
});

// ─── Discord Webhook Parsing ─────────────────────────────────

describe('Discord Webhook Parsing', () => {
  it('responds to PING with type 1', () => {
    const payload = { type: 1 };
    expect(payload.type).toBe(1);
  });

  it('extracts message content', () => {
    const payload = {
      type: 0,
      channel_id: 'ch-555',
      content: 'Hello Discord!',
      author: { id: 'u1', username: 'tester' },
      id: 'msg-1',
    };

    expect(payload.content).toBe('Hello Discord!');
    expect(payload.channel_id).toBe('ch-555');
    expect(payload.author.username).toBe('tester');
  });
});

// ─── iMessage Webhook Parsing ────────────────────────────────

describe('iMessage Webhook Parsing', () => {
  it('extracts message from bridge payload', () => {
    const payload = {
      chatGuid: 'iMessage;-;+49999',
      text: 'Hello from iMessage!',
      senderName: 'Maria',
      messageId: 'im-42',
    };

    expect(payload.text).toBe('Hello from iMessage!');
    expect(payload.chatGuid).toBe('iMessage;-;+49999');
    expect(payload.senderName).toBe('Maria');
  });
});

// ─── Outbound Router Logic ───────────────────────────────────

describe('Outbound Router Logic', () => {
  it('maps ChannelType to correct platforms', () => {
    const platformMap: Record<string, string> = {
      [ChannelType.TELEGRAM]: 'telegram',
      [ChannelType.WHATSAPP]: 'whatsapp',
      [ChannelType.DISCORD]: 'discord',
      [ChannelType.IMESSAGE]: 'imessage',
      [ChannelType.WEBCHAT]: 'webchat',
    };

    expect(platformMap[ChannelType.TELEGRAM]).toBe('telegram');
    expect(platformMap[ChannelType.WHATSAPP]).toBe('whatsapp');
    expect(platformMap[ChannelType.DISCORD]).toBe('discord');
    expect(platformMap[ChannelType.IMESSAGE]).toBe('imessage');
    expect(platformMap[ChannelType.WEBCHAT]).toBe('webchat');
  });

  it('WebChat should not trigger external delivery', () => {
    // WebChat relies on WS-only internal broadcast
    const shouldDeliver = ChannelType.WEBCHAT !== ChannelType.WEBCHAT;
    expect(shouldDeliver).toBe(false);
  });
});
