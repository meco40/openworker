import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('GET /api/channels/inbox', () => {
  let repo: SqliteMessageRepository;
  let previousFlag: string | undefined;
  let previousRequireAuth: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.CHAT_PERSISTENT_SESSION_V2;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    delete process.env.REQUIRE_AUTH;

    repo = new SqliteMessageRepository(':memory:');
    const telegramConversation = repo.getOrCreateConversation(
      ChannelType.TELEGRAM,
      'chat-tele-1',
      'Telegram Chat',
    );
    repo.saveMessage({
      conversationId: telegramConversation.id,
      role: 'user',
      content: 'hello telegram',
      platform: ChannelType.TELEGRAM,
    });

    const discordConversation = repo.getOrCreateConversation(
      ChannelType.DISCORD,
      'chat-discord-1',
      'Discord Chat',
    );
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
    if (previousRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH;
    } else {
      process.env.REQUIRE_AUTH = previousRequireAuth;
    }
  });

  it('returns unified inbox entries and supports channel filtering', async () => {
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox?channel=Telegram'));
    const json = (await response.json()) as {
      ok: boolean;
      items: Array<{
        conversationId: string;
        channelType: string;
        lastMessage: { content: string } | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].channelType).toBe(ChannelType.TELEGRAM);
    expect(json.items[0].lastMessage?.content).toBe('hello telegram');
  });

  it('returns 401 when REQUIRE_AUTH is true and no session exists', async () => {
    process.env.REQUIRE_AUTH = 'true';
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox'));

    expect(response.status).toBe(401);
  });

  it('returns same auth behavior regardless of chat session flag', async () => {
    process.env.REQUIRE_AUTH = 'true';
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const responseWhenFlagOff = await GET(new Request('http://localhost/api/channels/inbox'));

    process.env.CHAT_PERSISTENT_SESSION_V2 = 'true';
    const responseWhenFlagOn = await GET(new Request('http://localhost/api/channels/inbox'));

    expect(responseWhenFlagOff.status).toBe(401);
    expect(responseWhenFlagOn.status).toBe(401);
  });

  it('excludes conversations that are linked to Agent Room swarms', async () => {
    const linkedConversation = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'chat-linked-1',
      'Linked Chat',
    );
    repo.saveMessage({
      conversationId: linkedConversation.id,
      role: 'user',
      content: 'should stay out of inbox',
      platform: ChannelType.WEBCHAT,
    });

    repo.createAgentRoomSwarm?.({
      conversationId: linkedConversation.id,
      userId: linkedConversation.userId,
      title: 'Swarm Link',
      task: 'Link this conversation to a swarm',
      leadPersonaId: 'persona-1',
      units: [
        { personaId: 'persona-1', role: 'lead' },
        { personaId: 'persona-2', role: 'specialist' },
      ],
    });

    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox'));
    const json = (await response.json()) as {
      ok: boolean;
      items: Array<{
        conversationId: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items.some((item) => item.conversationId === linkedConversation.id)).toBe(false);
  });
});
