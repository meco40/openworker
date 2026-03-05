import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';

describe('GET /api/channels/inbox', () => {
  let repo: SqliteMessageRepository;
  let previousFlag: string | undefined;
  let previousRequireAuth: string | undefined;
  let previousInboxV2Enabled: string | undefined;
  let previousInboxHttpRateLimit: string | undefined;

  beforeEach(() => {
    previousFlag = process.env.CHAT_PERSISTENT_SESSION_V2;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    previousInboxV2Enabled = process.env.INBOX_V2_ENABLED;
    previousInboxHttpRateLimit = process.env.INBOX_HTTP_RATE_LIMIT_PER_MINUTE;
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    delete process.env.REQUIRE_AUTH;
    delete process.env.INBOX_V2_ENABLED;
    delete process.env.INBOX_HTTP_RATE_LIMIT_PER_MINUTE;
    (
      globalThis as typeof globalThis & {
        __inboxRateLimitBuckets?: unknown;
        __inboxObservabilityState?: unknown;
      }
    ).__inboxRateLimitBuckets = undefined;
    (
      globalThis as typeof globalThis & {
        __inboxRateLimitBuckets?: unknown;
        __inboxObservabilityState?: unknown;
      }
    ).__inboxObservabilityState = undefined;

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
    if (previousInboxV2Enabled === undefined) {
      delete process.env.INBOX_V2_ENABLED;
    } else {
      process.env.INBOX_V2_ENABLED = previousInboxV2Enabled;
    }
    if (previousInboxHttpRateLimit === undefined) {
      delete process.env.INBOX_HTTP_RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.INBOX_HTTP_RATE_LIMIT_PER_MINUTE = previousInboxHttpRateLimit;
    }
    (
      globalThis as typeof globalThis & {
        __inboxRateLimitBuckets?: unknown;
        __inboxObservabilityState?: unknown;
      }
    ).__inboxRateLimitBuckets = undefined;
    (
      globalThis as typeof globalThis & {
        __inboxRateLimitBuckets?: unknown;
        __inboxObservabilityState?: unknown;
      }
    ).__inboxObservabilityState = undefined;
  });

  it('returns unified inbox entries and supports channel filtering', async () => {
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(
      new Request('http://localhost/api/channels/inbox?channel=Telegram&version=2'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      items: Array<{
        conversationId: string;
        channelType: string;
        lastMessage: { content: string } | null;
      }>;
      page: {
        limit: number;
        returned: number;
        hasMore: boolean;
        nextCursor: string | null;
        totalMatched: number;
      };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toHaveLength(1);
    expect(json.items[0].channelType).toBe(ChannelType.TELEGRAM);
    expect(json.items[0].lastMessage?.content).toBe('hello telegram');
    expect(json.page.returned).toBe(1);
    expect(json.page.totalMatched).toBe(1);
    expect(json.page.hasMore).toBe(false);
  });

  it('returns v1 payload shape with deprecation headers when version=1', async () => {
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox?version=1'));
    const json = (await response.json()) as {
      ok: boolean;
      total: number;
      nextCursor: string | null;
      page?: unknown;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(Object.hasOwn(json, 'page')).toBe(false);
    expect(response.headers.get('deprecation')).toBe('true');
    expect(response.headers.get('sunset')).toBeTruthy();
  });

  it('applies query filter before limit and returns cursor pagination metadata', async () => {
    const alpha = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'chat-alpha', 'Alpha room');
    repo.saveMessage({
      conversationId: alpha.id,
      role: 'user',
      content: 'alpha payload',
      platform: ChannelType.TELEGRAM,
    });

    const beta = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'chat-beta', 'Beta room');
    repo.saveMessage({
      conversationId: beta.id,
      role: 'user',
      content: 'beta payload',
      platform: ChannelType.TELEGRAM,
    });

    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(
      new Request('http://localhost/api/channels/inbox?version=2&limit=1&q=beta'),
    );
    const json = (await response.json()) as {
      ok: boolean;
      items: Array<{ title: string }>;
      page: { returned: number; totalMatched: number; hasMore: boolean; nextCursor: string | null };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.page.returned).toBe(1);
    expect(json.page.totalMatched).toBe(1);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]?.title.toLowerCase()).toContain('beta');
    expect(json.page.hasMore).toBe(false);
    expect(json.page.nextCursor).toBeNull();
  });

  it('supports cursor pagination for v2', async () => {
    const c1 = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'chat-cursor-1', 'Cursor 1');
    repo.saveMessage({
      conversationId: c1.id,
      role: 'user',
      content: 'one',
      platform: ChannelType.TELEGRAM,
    });

    const c2 = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'chat-cursor-2', 'Cursor 2');
    repo.saveMessage({
      conversationId: c2.id,
      role: 'user',
      content: 'two',
      platform: ChannelType.TELEGRAM,
    });

    const { GET } = await import('../../../app/api/channels/inbox/route');
    const pageOneResponse = await GET(
      new Request('http://localhost/api/channels/inbox?version=2&limit=1'),
    );
    const pageOne = (await pageOneResponse.json()) as {
      ok: boolean;
      items: Array<{ conversationId: string }>;
      page: { hasMore: boolean; nextCursor: string | null };
    };

    expect(pageOneResponse.status).toBe(200);
    expect(pageOne.ok).toBe(true);
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.page.hasMore).toBe(true);
    expect(pageOne.page.nextCursor).toBeTruthy();

    const pageTwoResponse = await GET(
      new Request(
        `http://localhost/api/channels/inbox?version=2&limit=1&cursor=${encodeURIComponent(String(pageOne.page.nextCursor || ''))}`,
      ),
    );
    const pageTwo = (await pageTwoResponse.json()) as {
      ok: boolean;
      items: Array<{ conversationId: string }>;
      page: { returned: number };
    };

    expect(pageTwoResponse.status).toBe(200);
    expect(pageTwo.ok).toBe(true);
    expect(pageTwo.page.returned).toBe(1);
    expect(pageTwo.items[0]?.conversationId).not.toBe(pageOne.items[0]?.conversationId);
  });

  it('returns 503 when inbox v2 is disabled', async () => {
    process.env.INBOX_V2_ENABLED = 'false';
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const response = await GET(new Request('http://localhost/api/channels/inbox?version=2'));
    const json = (await response.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };

    expect(response.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe('UNAVAILABLE');
  });

  it('enforces HTTP rate limit for inbox listing', async () => {
    process.env.INBOX_HTTP_RATE_LIMIT_PER_MINUTE = '1';
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const first = await GET(new Request('http://localhost/api/channels/inbox?version=2'));
    const second = await GET(new Request('http://localhost/api/channels/inbox?version=2'));
    const secondJson = (await second.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(secondJson.ok).toBe(false);
    expect(secondJson.error?.code).toBe('RATE_LIMITED');
    expect(Number(second.headers.get('retry-after') || '0')).toBeGreaterThan(0);
  });

  it('tracks reconnect resync metric when resync flag is passed', async () => {
    const { GET } = await import('../../../app/api/channels/inbox/route');
    const { getInboxObservabilitySnapshot } =
      await import('../../../src/server/channels/inbox/observability');
    const baselineCount = getInboxObservabilitySnapshot().reconnectResyncCount;

    const inboxResponse = await GET(
      new Request('http://localhost/api/channels/inbox?version=2&resync=1'),
    );
    expect(inboxResponse.status).toBe(200);

    const afterCount = getInboxObservabilitySnapshot().reconnectResyncCount;

    expect(afterCount).toBe(baselineCount + 1);
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
