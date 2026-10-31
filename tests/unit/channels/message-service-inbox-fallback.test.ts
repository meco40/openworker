import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type Conversation } from '@/shared/domain/types';
import type {
  InboxItemRecord,
  MessageRepository,
  StoredMessage,
} from '@/server/channels/messages/repository';
import { MessageService } from '@/server/channels/messages/service/messageService';

function conversation(
  id: string,
  title: string,
  updatedAt: string,
  channelType: ChannelType = ChannelType.WEBCHAT,
): Conversation {
  return {
    id,
    channelType,
    externalChatId: id,
    userId: 'user-1',
    title,
    modelOverride: null,
    personaId: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function message(id: string, conversationId: string, content: string): StoredMessage {
  return {
    id,
    conversationId,
    seq: 1,
    role: 'user',
    content,
    platform: ChannelType.WEBCHAT,
    externalMsgId: null,
    senderName: null,
    metadata: null,
    createdAt: '2026-10-08T10:00:00.000Z',
  };
}

function createService(
  options: {
    conversations?: Conversation[];
    messages?: Record<string, StoredMessage[]>;
    getInboxItem?: (conversationId: string, userId: string) => InboxItemRecord | null;
  } = {},
) {
  const conversations = options.conversations ?? [];
  const repository = {
    listConversations: vi.fn<() => Conversation[]>(() => conversations),
    listMessages: vi.fn<(conversationId: string) => StoredMessage[]>(
      (conversationId: string) => options.messages?.[conversationId] ?? [],
    ),
    getConversation: vi.fn<(conversationId: string) => Conversation | null>(
      (conversationId: string) => conversations.find((item) => item.id === conversationId) ?? null,
    ),
    ...(options.getInboxItem ? { getInboxItem: options.getInboxItem } : {}),
  } as unknown as MessageRepository;
  return { service: new MessageService(repository), repository };
}

describe('MessageService inbox compatibility fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts conversations, returns the last message when available, and leaves empty conversations blank', () => {
    const newer = conversation('conversation-b', 'Beta', '2026-10-08T10:00:00.000Z');
    const tieBreak = conversation('conversation-c', 'Gamma', '2026-10-08T10:00:00.000Z');
    const older = conversation('conversation-a', 'Alpha', '2026-10-07T10:00:00.000Z');
    const { service } = createService({
      conversations: [older, newer, tieBreak],
      messages: {
        [newer.id]: [message('first', newer.id, 'earlier'), message('last', newer.id, 'latest')],
      },
    });

    const result = service.listInbox({ userId: 'user-1' });

    expect(result).toMatchObject({ limit: 50, hasMore: false, totalMatched: 3, nextCursor: null });
    expect(result.items.map((item) => item.conversationId)).toEqual([
      'conversation-c',
      'conversation-b',
      'conversation-a',
    ]);
    expect(result.items[1]?.lastMessage).toMatchObject({ id: 'last', content: 'latest' });
    expect(result.items[0]?.lastMessage).toBeNull();
  });

  it('filters by normalized channel and title, and pages through matching results by cursor', () => {
    const a = conversation('a', 'Project Alpha', '2026-10-08T10:00:00.000Z');
    const b = conversation('b', 'Project Beta', '2026-10-07T10:00:00.000Z');
    const c = conversation('c', 'Project Gamma', '2026-10-06T10:00:00.000Z');
    const otherChannel = conversation(
      'd',
      'Project Delta',
      '2026-10-09T10:00:00.000Z',
      ChannelType.DISCORD,
    );
    const { service } = createService({ conversations: [a, b, c, otherChannel] });

    const first = service.listInbox({
      userId: 'user-1',
      channel: ' WEBCHAT ',
      query: ' project ',
      limit: 1,
    });
    const second = service.listInbox({
      userId: 'user-1',
      channel: 'webchat',
      query: 'project',
      limit: 1,
      cursor: first.nextCursor,
    });
    const unknownCursor = service.listInbox({
      userId: 'user-1',
      channel: 'webchat',
      query: 'project',
      limit: 1,
      cursor: { updatedAt: 'missing', conversationId: 'missing' },
    });

    expect(first.items.map((item) => item.conversationId)).toEqual(['a']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ updatedAt: a.updatedAt, conversationId: a.id });
    expect(second.items.map((item) => item.conversationId)).toEqual(['b']);
    expect(unknownCursor.items.map((item) => item.conversationId)).toEqual(['a']);
  });

  it('matches message content and rejects a nonmatching query', () => {
    const item = conversation('a', 'Unrelated title', '2026-10-08T10:00:00.000Z');
    const { service } = createService({
      conversations: [item],
      messages: { [item.id]: [message('m1', item.id, 'A needle in the transcript')] },
    });

    expect(service.listInbox({ userId: 'user-1', query: 'needle' }).items).toHaveLength(1);
    expect(service.listInbox({ userId: 'user-1', query: 'absent' })).toMatchObject({
      items: [],
      totalMatched: 0,
      nextCursor: null,
    });
  });

  it('clamps limits and restarts pagination when a cursor is not present', () => {
    const a = conversation('a', 'Alpha', '2026-10-08T10:00:00.000Z');
    const b = conversation('b', 'Beta', '2026-10-07T10:00:00.000Z');
    const { service } = createService({ conversations: [a, b] });

    expect(service.listInbox({ userId: 'user-1', limit: 0 }).limit).toBe(50);
    expect(service.listInbox({ userId: 'user-1', limit: -5 }).limit).toBe(1);
    expect(service.listInbox({ userId: 'user-1', limit: 500 }).limit).toBe(100);
    expect(
      service.listInbox({
        userId: 'user-1',
        limit: 1,
        cursor: { updatedAt: 'missing', conversationId: 'missing' },
      }).items[0]?.conversationId,
    ).toBe('a');
  });

  it('uses the repository item when available and builds or omits the item in fallback mode', () => {
    const item = conversation('a', 'Alpha', '2026-10-08T10:00:00.000Z');
    const lastMessage = message('m1', item.id, 'latest');
    const repositoryItem: InboxItemRecord = {
      conversationId: item.id,
      channelType: item.channelType,
      title: item.title,
      updatedAt: item.updatedAt,
      lastMessage: null,
    };
    const direct = createService({
      conversations: [item],
      getInboxItem: vi.fn<() => InboxItemRecord>(() => repositoryItem),
    });
    const fallback = createService({
      conversations: [item],
      messages: { [item.id]: [lastMessage] },
    });
    const missing = createService();

    expect(direct.service.getInboxItem(item.id, 'user-1')).toBe(repositoryItem);
    expect(fallback.service.getInboxItem(item.id, 'user-1')?.lastMessage).toMatchObject({
      id: lastMessage.id,
      content: lastMessage.content,
    });
    expect(missing.service.getInboxItem('missing', 'user-1')).toBeNull();
  });
});
