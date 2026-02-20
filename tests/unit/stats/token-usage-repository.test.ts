import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenUsageRepository } from '@/server/stats/tokenUsageRepository';

describe('TokenUsageRepository', () => {
  let repo: TokenUsageRepository;

  beforeEach(() => {
    repo = new TokenUsageRepository(':memory:');
  });

  afterEach(() => {
    repo.close();
  });

  describe('recordUsage', () => {
    it('should record a usage entry and return it', () => {
      const entry = repo.recordUsage('gemini', 'gemini-2.0-flash', 100, 200, 300);

      expect(entry.providerId).toBe('gemini');
      expect(entry.modelName).toBe('gemini-2.0-flash');
      expect(entry.promptTokens).toBe(100);
      expect(entry.completionTokens).toBe(200);
      expect(entry.totalTokens).toBe(300);
      expect(entry.id).toMatch(/^tu-/);
      expect(entry.createdAt).toBeTruthy();
    });

    it('should store multiple entries', () => {
      repo.recordUsage('gemini', 'gemini-2.0-flash', 100, 200, 300);
      repo.recordUsage('openai', 'gpt-4o', 50, 150, 200);
      repo.recordUsage('anthropic', 'claude-3-5-sonnet', 80, 120, 200);

      expect(repo.getEntryCount()).toBe(3);
    });
  });

  describe('getTotalTokens', () => {
    it('should return zeros when no entries exist', () => {
      const total = repo.getTotalTokens();
      expect(total.promptTokens).toBe(0);
      expect(total.completionTokens).toBe(0);
      expect(total.totalTokens).toBe(0);
    });

    it('should return aggregated totals', () => {
      repo.recordUsage('gemini', 'gemini-2.0-flash', 100, 200, 300);
      repo.recordUsage('openai', 'gpt-4o', 50, 150, 200);

      const total = repo.getTotalTokens();
      expect(total.promptTokens).toBe(150);
      expect(total.completionTokens).toBe(350);
      expect(total.totalTokens).toBe(500);
    });

    it('should filter by time range', () => {
      repo.recordUsage('gemini', 'flash', 100, 100, 200);

      // Query for a range in the far future — should find nothing
      const total = repo.getTotalTokens('2099-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z');
      expect(total.totalTokens).toBe(0);

      // Query for a range that includes now
      const all = repo.getTotalTokens('2020-01-01T00:00:00.000Z');
      expect(all.totalTokens).toBe(200);
    });
  });

  describe('getUsageSummary', () => {
    it('should return empty array when no entries exist', () => {
      expect(repo.getUsageSummary()).toEqual([]);
    });

    it('should group by provider and model', () => {
      repo.recordUsage('gemini', 'gemini-2.0-flash', 100, 200, 300);
      repo.recordUsage('gemini', 'gemini-2.0-flash', 50, 100, 150);
      repo.recordUsage('openai', 'gpt-4o', 80, 120, 200);

      const summary = repo.getUsageSummary();
      expect(summary).toHaveLength(2);

      const gemini = summary.find((s) => s.model === 'gemini-2.0-flash');
      expect(gemini).toBeDefined();
      expect(gemini!.promptTokens).toBe(150);
      expect(gemini!.completionTokens).toBe(300);
      expect(gemini!.totalTokens).toBe(450);

      const openai = summary.find((s) => s.model === 'gpt-4o');
      expect(openai).toBeDefined();
      expect(openai!.totalTokens).toBe(200);
    });

    it('should sort by total_tokens descending', () => {
      repo.recordUsage('openai', 'gpt-4o', 10, 10, 20);
      repo.recordUsage('gemini', 'flash', 1000, 500, 1500);

      const summary = repo.getUsageSummary();
      expect(summary[0].model).toBe('flash');
      expect(summary[1].model).toBe('gpt-4o');
    });

    it('should respect time range filter', () => {
      repo.recordUsage('gemini', 'flash', 100, 100, 200);

      const empty = repo.getUsageSummary('2099-01-01T00:00:00.000Z');
      expect(empty).toEqual([]);

      const found = repo.getUsageSummary('2020-01-01T00:00:00.000Z');
      expect(found).toHaveLength(1);
    });
  });

  describe('listEntries', () => {
    it('should return all entries ordered by created_at desc', () => {
      repo.recordUsage('a', 'm1', 1, 1, 2);
      repo.recordUsage('b', 'm2', 2, 2, 4);
      repo.recordUsage('c', 'm3', 3, 3, 6);

      const entries = repo.listEntries();
      expect(entries).toHaveLength(3);
      // Most recent first
      expect(entries[0].providerId).toBe('c');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        repo.recordUsage('p', `m${i}`, i, i, i * 2);
      }

      const entries = repo.listEntries(undefined, undefined, 3);
      expect(entries).toHaveLength(3);
    });
  });

  describe('getEntryCount', () => {
    it('should return 0 for empty db', () => {
      expect(repo.getEntryCount()).toBe(0);
    });

    it('should count all entries', () => {
      repo.recordUsage('a', 'b', 1, 1, 2);
      repo.recordUsage('c', 'd', 1, 1, 2);
      expect(repo.getEntryCount()).toBe(2);
    });
  });

  describe('clearEntries', () => {
    it('should delete all token usage rows and return deleted count', () => {
      repo.recordUsage('openrouter', 'x-ai/grok-4-fast', 10, 5, 15);
      repo.recordUsage('manual', 'manual-model', 1, 0, 1);

      const deleted = repo.clearEntries();

      expect(deleted).toBe(2);
      expect(repo.getEntryCount()).toBe(0);
      expect(repo.getTotalTokens().totalTokens).toBe(0);
    });
  });
});
