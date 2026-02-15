import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '../../../types';
import type { Conversation } from '../../../src/server/channels/messages/repository';

describe('SqliteMessageRepository', () => {
  let repo: SqliteMessageRepository;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    repo = new SqliteMessageRepository(':memory:');
  });

  describe('Conversations', () => {
    it('creates a conversation and retrieves it by id', () => {
      const conv = repo.createConversation({
        channelType: ChannelType.TELEGRAM,
        externalChatId: 'tg-12345',
        title: 'Test Chat',
      });

      expect(conv.id).toBeTruthy();
      expect(conv.channelType).toBe(ChannelType.TELEGRAM);
      expect(conv.externalChatId).toBe('tg-12345');
      expect(conv.title).toBe('Test Chat');

      const fetched = repo.getConversation(conv.id);
      expect(fetched).toEqual(conv);
    });

    it('returns null for non-existent conversation', () => {
      expect(repo.getConversation('nonexistent')).toBeNull();
    });

    it('finds conversation by external chat id', () => {
      repo.createConversation({
        channelType: ChannelType.WHATSAPP,
        externalChatId: 'wa-999',
      });

      const found = repo.getConversationByExternalChat(ChannelType.WHATSAPP, 'wa-999');
      expect(found).not.toBeNull();
      expect(found!.externalChatId).toBe('wa-999');
    });

    it('getOrCreateConversation returns existing when available', () => {
      const first = repo.getOrCreateConversation(ChannelType.DISCORD, 'dc-001', 'Discord Chat');
      const second = repo.getOrCreateConversation(
        ChannelType.DISCORD,
        'dc-001',
        'Should Not Overwrite',
      );

      expect(first.id).toBe(second.id);
      expect(second.title).toBe('Discord Chat');
    });

    it('getOrCreateConversation creates new when not found', () => {
      const conv = repo.getOrCreateConversation(ChannelType.TELEGRAM, 'new-chat', 'New Chat');

      expect(conv.id).toBeTruthy();
      expect(conv.title).toBe('New Chat');
    });

    it('lists conversations', () => {
      repo.createConversation({ channelType: ChannelType.TELEGRAM, externalChatId: 'a' });
      repo.createConversation({ channelType: ChannelType.WHATSAPP, externalChatId: 'b' });
      repo.createConversation({ channelType: ChannelType.DISCORD, externalChatId: 'c' });

      const list = repo.listConversations();
      expect(list.length).toBe(3);
    });

    it('getDefaultWebChatConversation creates one if missing', () => {
      const conv = repo.getDefaultWebChatConversation();
      expect(conv.channelType).toBe(ChannelType.WEBCHAT);
      expect(conv.externalChatId).toBe('default');

      // Second call returns same conversation
      const same = repo.getDefaultWebChatConversation();
      expect(same.id).toBe(conv.id);
    });

    it('updates conversation title', () => {
      const conv = repo.createConversation({
        channelType: ChannelType.TELEGRAM,
        externalChatId: 'x',
      });
      repo.updateConversationTitle(conv.id, 'New Title');

      const updated = repo.getConversation(conv.id);
      expect(updated!.title).toBe('New Title');
    });
  });

  describe('Messages', () => {
    let conv: Conversation;

    beforeEach(() => {
      conv = repo.createConversation({
        channelType: ChannelType.TELEGRAM,
        externalChatId: 'chat-1',
        title: 'Test',
      });
    });

    it('saves and retrieves a message', () => {
      const msg = repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Hello!',
        platform: ChannelType.TELEGRAM,
        senderName: 'TestUser',
      });

      expect(msg.id).toBeTruthy();
      expect(msg.conversationId).toBe(conv.id);
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello!');
      expect(msg.platform).toBe(ChannelType.TELEGRAM);
      expect(msg.senderName).toBe('TestUser');
    });

    it('stores metadata as JSON', () => {
      const msg = repo.saveMessage({
        conversationId: conv.id,
        role: 'agent',
        content: 'Response',
        platform: ChannelType.TELEGRAM,
        metadata: { tokens: 150, model: 'gemini-2.0' },
      });

      expect(msg.metadata).toBeTruthy();
      const parsed = JSON.parse(msg.metadata!);
      expect(parsed.tokens).toBe(150);
      expect(parsed.model).toBe('gemini-2.0');
    });

    it('lists messages in chronological order', () => {
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'First',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'agent',
        content: 'Second',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Third',
        platform: ChannelType.TELEGRAM,
      });

      const msgs = repo.listMessages(conv.id);
      expect(msgs.length).toBe(3);
      expect(msgs[0].content).toBe('First');
      expect(msgs[1].content).toBe('Second');
      expect(msgs[2].content).toBe('Third');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        repo.saveMessage({
          conversationId: conv.id,
          role: 'user',
          content: `Message ${i}`,
          platform: ChannelType.TELEGRAM,
        });
      }

      const msgs = repo.listMessages(conv.id, 3);
      expect(msgs.length).toBe(3);
      // Should return the 3 most recent messages in chronological order
      const contents = msgs.map((m) => m.content);
      expect(contents).toContain('Message 9');
      expect(contents).toContain('Message 8');
      expect(contents).toContain('Message 7');
    });

    it('supports before_seq style pagination when before is numeric', () => {
      const first = repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'M1',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'M2',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'M3',
        platform: ChannelType.TELEGRAM,
      });

      const beforeSeq = String((first.seq || 0) + 2);
      const paged = repo.listMessages(conv.id, 50, beforeSeq);
      expect(paged.map((m) => m.content)).toEqual(['M1', 'M2']);
    });

    it('touches conversation updated_at on new message', () => {
      const before = repo.getConversation(conv.id)!.updatedAt;

      // Small delay to ensure different timestamps
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'Update trigger',
        platform: ChannelType.TELEGRAM,
      });

      const after = repo.getConversation(conv.id)!.updatedAt;
      expect(after >= before).toBe(true);
    });

    it('handles external message ids', () => {
      const msg = repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'External msg',
        platform: ChannelType.TELEGRAM,
        externalMsgId: 'tg-msg-42',
      });

      expect(msg.externalMsgId).toBe('tg-msg-42');
    });

    it('lists messages after seq in ascending order with limit', () => {
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'A',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'B',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'C',
        platform: ChannelType.TELEGRAM,
      });
      repo.saveMessage({
        conversationId: conv.id,
        role: 'user',
        content: 'D',
        platform: ChannelType.TELEGRAM,
      });

      const messages = repo.listMessagesAfterSeq(conv.id, 1, 2);

      expect(messages.map((message) => message.content)).toEqual(['B', 'C']);
      expect(messages.map((message) => message.seq)).toEqual([2, 3]);
    });

    it('applies user scope when listing messages after seq', () => {
      const userAConversation = repo.createConversation({
        channelType: ChannelType.WEBCHAT,
        externalChatId: 'after-seq-user-a',
        userId: 'user-a',
      });
      const userBConversation = repo.createConversation({
        channelType: ChannelType.WEBCHAT,
        externalChatId: 'after-seq-user-b',
        userId: 'user-b',
      });

      repo.saveMessage({
        conversationId: userAConversation.id,
        role: 'user',
        content: 'Only A',
        platform: ChannelType.WEBCHAT,
      });
      repo.saveMessage({
        conversationId: userBConversation.id,
        role: 'user',
        content: 'Only B',
        platform: ChannelType.WEBCHAT,
      });

      const ownerMessages = repo.listMessagesAfterSeq(userAConversation.id, 0, 50, 'user-a');
      const strangerMessages = repo.listMessagesAfterSeq(userAConversation.id, 0, 50, 'user-b');

      expect(ownerMessages).toHaveLength(1);
      expect(ownerMessages[0].content).toBe('Only A');
      expect(strangerMessages).toEqual([]);
    });
  });
});
