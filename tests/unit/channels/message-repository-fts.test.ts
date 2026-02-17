import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '../../../types';

describe('SqliteMessageRepository — FTS5 search', () => {
  let repo: SqliteMessageRepository;
  const userId = 'test-user';

  beforeEach(() => {
    repo = new SqliteMessageRepository(':memory:');
  });

  function seedConversation(channelType: ChannelType = ChannelType.WEBCHAT, personaId?: string) {
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

    it('finds messages matching multiple words (OR logic, best match first)', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'I bought a radio from Andreas at the flea market');
      seedMessage(conv.id, 'Andreas called me yesterday');
      seedMessage(conv.id, 'I need a new radio antenna');

      // OR semantics: all three messages match at least one term, ranked by BM25
      const results = repo.searchMessages('Andreas radio', { userId });
      expect(results.length).toBe(3);
      // The message matching BOTH terms should rank first
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

    it('handles comma-separated query terms without FTS syntax errors', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'I bought a radio from Andreas yesterday');
      seedMessage(conv.id, 'Completely unrelated content');

      expect(() => repo.searchMessages('Andreas,radio', { userId })).not.toThrow();
      const results = repo.searchMessages('Andreas,radio', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Andreas');
      expect(results[0].content).toContain('radio');
    });

    it('handles natural-language parentheses and colons without FTS syntax errors', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Max sagt dass er verwundert ist');
      seedMessage(conv.id, 'Other unrelated message');

      expect(() => repo.searchMessages('Max (verwundert:sagt)', { userId })).not.toThrow();
      const results = repo.searchMessages('Max (verwundert:sagt)', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Max');
    });

    it('handles asterisk-wrapped words without triggering special FTS queries', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Max sagt hallo');
      seedMessage(conv.id, 'Completely unrelated content');

      expect(() => repo.searchMessages('*max* sagt', { userId })).not.toThrow();
      const results = repo.searchMessages('*max* sagt', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Max');
    });

    it('filters by personaId — only returns messages from matching persona conversations', () => {
      const convNata = seedConversation(ChannelType.TELEGRAM, 'persona-nata');
      const convNexus = seedConversation(ChannelType.WEBCHAT, 'persona-nexus');

      seedMessage(convNata.id, 'Die Regeln im Office sind streng');
      seedMessage(convNexus.id, 'Office Regeln sind hier dokumentiert');

      const nataResults = repo.searchMessages('Regeln Office', {
        userId,
        personaId: 'persona-nata',
      });
      expect(nataResults.length).toBe(1);
      expect(nataResults[0].conversationId).toBe(convNata.id);

      const nexusResults = repo.searchMessages('Regeln Office', {
        userId,
        personaId: 'persona-nexus',
      });
      expect(nexusResults.length).toBe(1);
      expect(nexusResults[0].conversationId).toBe(convNexus.id);
    });

    it('returns messages from all personas when personaId is not specified', () => {
      const convNata = seedConversation(ChannelType.TELEGRAM, 'persona-nata');
      const convNexus = seedConversation(ChannelType.WEBCHAT, 'persona-nexus');

      seedMessage(convNata.id, 'Die Regeln im Office sind streng');
      seedMessage(convNexus.id, 'Office Regeln sind hier dokumentiert');

      const allResults = repo.searchMessages('Regeln Office', { userId });
      expect(allResults.length).toBe(2);
    });

    it('strips German stop words from query so recall is not overly restrictive', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Die Regeln bei der Arbeit sind: pünktlich, höflich, proaktiv.');
      seedMessage(conv.id, 'Heute war ein guter Tag.');

      // "Wie sind die Regeln?" → stop words stripped → just "Regeln"
      const results = repo.searchMessages('Wie sind die Regeln?', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Regeln');
    });

    it('falls back to full query when all tokens are stop words', () => {
      const conv = seedConversation();
      seedMessage(conv.id, 'Wie ist es dir so?');
      seedMessage(conv.id, 'Das Wetter war schön.');

      // "Wie ist es" → all stop words → fall back to AND-join of all tokens
      const results = repo.searchMessages('Wie ist es', { userId });
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Wie ist es');
    });
  });
});
