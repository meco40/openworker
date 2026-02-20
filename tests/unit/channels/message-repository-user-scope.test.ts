import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '@/shared/domain/types';

describe('SqliteMessageRepository user scoping', () => {
  let repo: SqliteMessageRepository;

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
  });

  it('creates separate default webchat conversations per user', () => {
    const conversationA = repo.getDefaultWebChatConversation('user-a');
    const conversationB = repo.getDefaultWebChatConversation('user-b');

    expect(conversationA.id).not.toBe(conversationB.id);
  });

  it('prevents reading another users conversation messages', () => {
    const conversationA = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      'Chat A',
      'user-a',
    );
    const conversationB = repo.getOrCreateConversation(
      ChannelType.WEBCHAT,
      'default',
      'Chat B',
      'user-b',
    );

    repo.saveMessage({
      conversationId: conversationA.id,
      role: 'user',
      content: 'Hello from A',
      platform: ChannelType.WEBCHAT,
    });

    repo.saveMessage({
      conversationId: conversationB.id,
      role: 'user',
      content: 'Hello from B',
      platform: ChannelType.WEBCHAT,
    });

    const ownerMessages = repo.listMessages(conversationA.id, 100, undefined, 'user-a');
    const strangerMessages = repo.listMessages(conversationA.id, 100, undefined, 'user-b');

    expect(ownerMessages).toHaveLength(1);
    expect(ownerMessages[0].content).toBe('Hello from A');
    expect(strangerMessages).toHaveLength(0);
  });
});
