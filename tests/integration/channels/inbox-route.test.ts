import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelType } from '../../../types';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';

describe('GET /api/channels/inbox', () => {
  let repo: SqliteMessageRepository;
  let previousFlag: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.CHAT_PERSISTENT_SESSION_V2;
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';

    repo = new SqliteMessageRepository(':memory:');
    const telegramConversation = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'chat-tele-1', 'Telegram Chat');
    repo.saveMessage({
      conversationId: telegramConversation.id,
      role: 'user',
      content: 'hello telegram',
      platform: ChannelType.TELEGRAM,
    });

    const discordConversation = repo.getOrCreateConversation(ChannelType.DISCORD, 'chat-discord-1', 'Discord Chat');
    repo.saveMessage({
      conversationId: discordConversation.id,
      role: 'user',
      content: 'hello discord',
      platform: ChannelType.DISCORD,
    });

    globalThis.__messageRepository = repo;
    globalThis.__messageService = undefined;
  });

  afterEach(() => {
    repo.close();
    globalThis.__messageRepository = undefined;
    globalThis.__messageService = undefined;
    process.env.CHAT_PERSISTENT_SESSION_V2 = previousFlag;
  });

  it('returns unified inbox entries and supports channel filtering', async () => {
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox?channel=Telegram'));
    const json = (await response.json()) as {
      ok: boolean;
      items: Array<{ conversationId: string; channelType: string; lastMessage: { content: string } | null }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].channelType).toBe(ChannelType.TELEGRAM);
    expect(json.items[0].lastMessage?.content).toBe('hello telegram');
  });
});
