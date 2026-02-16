import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '../../../types';

describe('SqliteMessageRepository — FTS5 search', () => {
  let repo: SqliteMessageRepository;
  const userId = 'test-user';

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
  });

  function seedConversation(
    channelType: ChannelType = ChannelType.WEBCHAT,
    personaId?: string,
  ) {
    return repo.createConversation({
      channelType,
      externalChatId: `ext-${Date.now()}-${Math.random()}`,
      title: 'Test',
      userId,
      personaId,
    });
  }

  function seedMessage(conversationId: string, content: string, role: 'user' | 'agent' = 'user') {
    return repo.saveMessage({
      conversationId,
      role,
      content,
      platform: ChannelType.WEBCHAT,
    });
  }

  describe('searchMessages', () => {
    it('finds messages matching a simple keyword', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'I visited Aldi today and bought groceries');
      seedMessage(conv.id, 'The weather was nice');
      seedMessage(conv.id, 'Then I went to the park');

      const results = repo.searchMessages('Aldi', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Aldi');
    });

    it('finds messages matching multiple words (AND logic)', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'I bought a radio from Andreas at the flea market');
      seedMessage(conv.id, 'Andreas called me yesterday');
      seedMessage(conv.id, 'I need a new radio antenna');

      // Searching "Andreas radio" should match only the first message
      const results = repo.searchMessages('Andreas radio', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Andreas');
      expect(results[0].content).toContain('radio');
    });

    it('returns empty array when no match', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Nothing relevant here');

      const results = repo.searchMessages('xylophone', { userId });
      expect(results.length).toBe(0);
    });

    it('respects limit parameter', () => {
      const conv = seedConversation();
      for (let i = 0; i < 10; i++) {
        seedMessage(conv.id, `Meeting with client number ${i}`);
      }

      const results = repo.searchMessages('Meeting client', { userId, limit: 3 });
      expect(results.length).toBe(3);
    });

    it('orders results by relevance (BM25)', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'The cat sat on the mat');
      seedMessage(conv.id, 'Aldi Aldi Aldi — three visits to Aldi this week');
      seedMessage(conv.id, 'I stopped by Aldi briefly');

      const results = repo.searchMessages('Aldi', { userId });
      expect(results.length).toBe(2);
      // The message with more "Aldi" occurrences should rank higher
      expect(results[0].content).toContain('three visits');
    });

    it('searches across multiple conversations', () => {
      const conv1 = seedConversation();
      const conv2 = seedConversation(ChannelType.TELEGRAM);

      seedMessage(conv1.id, 'Bought coffee at Starbucks');
      seedMessage(conv2.id, 'Starbucks has a new menu');

      const results = repo.searchMessages('Starbucks', { userId });
      expect(results.length).toBe(2);
    });

    it('filters by conversationId when provided', () => {
      const conv1 = seedConversation();
      const conv2 = seedConversation();

      seedMessage(conv1.id, 'Project Alpha update');
      seedMessage(conv2.id, 'Project Alpha meeting notes');

      const results = repo.searchMessages('Alpha', { userId, conversationId: conv1.id });
      expect(results.length).toBe(1);
    });

    it('filters by role when provided', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'User asking about Berlin trip', 'user');
      seedMessage(conv.id, 'Here is info about Berlin trip', 'agent');

      const userOnly = repo.searchMessages('Berlin', { userId, role: 'user' });
      expect(userOnly.length).toBe(1);
      expect(userOnly[0].role).toBe('user');
    });

    it('includes conversation metadata in results', () => {
      const conv = seedConversation(ChannelType.TELEGRAM, 'persona-1');
      seedMessage(conv.id, 'Telegram specific message about cooking');

      const results = repo.searchMessages('cooking', { userId });
      expect(results.length).toBe(1);
      expect(results[0].conversationId).toBe(conv.id);
    });

    it('handles German text with diacritics (ä, ö, ü, ß)', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Ich war beim Bäcker und kaufte Brötchen');
      seedMessage(conv.id, 'Die Straße war sehr lang');

      // FTS5 with remove_diacritics should allow matching without diacritics
      const results = repo.searchMessages('Backer', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Bäcker');
    });

    it('handles prefix matching with wildcard', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Programming in TypeScript is fun');
      seedMessage(conv.id, 'Type systems prevent bugs');

      const results = repo.searchMessages('Type*', { userId });
      expect(results.length).toBe(2);
    });

    it('returns results with createdAt for temporal ordering', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'First message about dogs');
      seedMessage(conv.id, 'Second message about dogs');

      const results = repo.searchMessages('dogs', { userId });
      expect(results.length).toBe(2);
      // Each result should have createdAt
      for (const r of results) {
        expect(r.createdAt).toBeTruthy();
      }
    });
  });
});
