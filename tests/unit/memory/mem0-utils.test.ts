import { describe, it, expect } from 'vitest';
import {
  pickRecord,
  pickString,
  pickNumber,
  extractMemories,
  toMemoryRecord,
  extractHits,
  toHistoryEntry,
  extractHistory,
  extractId,
  extractListMeta,
} from '@/server/memory/mem0/utils';

const missingValue: unknown = ({} as { missing?: unknown }).missing;

describe('mem0/utils', () => {
  describe('pickRecord', () => {
    it('returns object from plain object', () => {
      const input = { foo: 'bar', num: 123 };
      expect(pickRecord(input)).toEqual(input);
    });

    it('returns empty object from non-object', () => {
      expect(pickRecord(null)).toEqual({});
      expect(pickRecord(missingValue)).toEqual({});
      expect(pickRecord('string')).toEqual({});
      expect(pickRecord(123)).toEqual({});
    });

    it('returns empty object from array', () => {
      expect(pickRecord([1, 2, 3])).toEqual({});
    });
  });

  describe('pickString', () => {
    it('returns trimmed string', () => {
      expect(pickString('  hello  ')).toBe('hello');
      expect(pickString('test')).toBe('test');
    });

    it('returns null for non-string', () => {
      expect(pickString(null)).toBeNull();
      expect(pickString(missingValue)).toBeNull();
      expect(pickString(123)).toBeNull();
      expect(pickString({})).toBeNull();
    });

    it('returns null for empty/whitespace string', () => {
      expect(pickString('')).toBeNull();
      expect(pickString('   ')).toBeNull();
      expect(pickString('\t\n')).toBeNull();
    });
  });

  describe('pickNumber', () => {
    it('returns finite number', () => {
      expect(pickNumber(123)).toBe(123);
      expect(pickNumber(0)).toBe(0);
      expect(pickNumber(-5)).toBe(-5);
      expect(pickNumber(3.14)).toBe(3.14);
    });

    it('returns null for non-number', () => {
      expect(pickNumber(null)).toBeNull();
      expect(pickNumber(missingValue)).toBeNull();
      expect(pickNumber('123')).toBeNull();
    });

    it('returns null for Infinity/NaN', () => {
      expect(pickNumber(Infinity)).toBeNull();
      expect(pickNumber(-Infinity)).toBeNull();
      expect(pickNumber(NaN)).toBeNull();
    });
  });

  describe('extractMemories', () => {
    it('extracts from memories array', () => {
      const payload = { memories: [{ id: '1' }, { id: '2' }] };
      expect(extractMemories(payload)).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('extracts from results array', () => {
      const payload = { results: [{ id: '1' }] };
      expect(extractMemories(payload)).toEqual([{ id: '1' }]);
    });

    it('extracts from data array', () => {
      const payload = { data: [{ id: '1' }] };
      expect(extractMemories(payload)).toEqual([{ id: '1' }]);
    });

    it('returns array if payload is array', () => {
      const payload = [{ id: '1' }, { id: '2' }];
      expect(extractMemories(payload)).toEqual(payload);
    });

    it('returns empty array for unknown structure', () => {
      expect(extractMemories({ foo: 'bar' })).toEqual([]);
      expect(extractMemories(null)).toEqual([]);
      expect(extractMemories(missingValue)).toEqual([]);
    });
  });

  describe('toMemoryRecord', () => {
    it('converts flat structure', () => {
      const entry = {
        id: 'mem-1',
        memory: 'Test content',
        score: 0.95,
        metadata: { source: 'test' },
        created_at: '2026-01-01',
      };

      const result = toMemoryRecord(entry);

      expect(result).toEqual({
        id: 'mem-1',
        content: 'Test content',
        score: 0.95,
        metadata: { source: 'test' },
        createdAt: '2026-01-01',
        updatedAt: undefined,
      });
    });

    it('converts nested structure', () => {
      const entry = {
        memory_id: 'mem-2',
        memory: {
          id: 'nested-id',
          text: 'Nested content',
        },
        similarity: 0.85,
      };

      const result = toMemoryRecord(entry);

      expect(result?.id).toBe('mem-2');
      expect(result?.content).toBe('Nested content');
      expect(result?.score).toBe(0.85);
    });

    it('handles multiple ID fields', () => {
      const entry = {
        id: 'primary',
        memory_id: 'secondary',
        memory: { id: 'tertiary' },
        content: 'Content',
      };

      const result = toMemoryRecord(entry);
      expect(result?.id).toBe('primary');
    });

    it('handles multiple content fields', () => {
      const entry = {
        id: 'mem-3',
        memory: 'memory-field',
        text: 'text-field',
        content: 'content-field',
      };

      const result = toMemoryRecord(entry);
      expect(result?.content).toBe('memory-field');
    });

    it('returns null for missing ID', () => {
      const entry = { content: 'No ID' };
      expect(toMemoryRecord(entry)).toBeNull();
    });

    it('returns null for missing content', () => {
      const entry = { id: 'mem-4' };
      expect(toMemoryRecord(entry)).toBeNull();
    });

    it('handles missing optional fields', () => {
      const entry = { id: 'mem-5', memory: 'Minimal' };
      const result = toMemoryRecord(entry);

      expect(result?.score).toBeNull();
      expect(result?.metadata).toEqual({});
      expect(result?.createdAt).toBeUndefined();
    });

    it('handles camelCase timestamps', () => {
      const entry = {
        id: 'mem-6',
        memory: 'CamelCase',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      };

      const result = toMemoryRecord(entry);
      expect(result?.createdAt).toBe('2026-01-01T00:00:00Z');
      expect(result?.updatedAt).toBe('2026-01-02T00:00:00Z');
    });
  });

  describe('extractHits', () => {
    it('extracts and converts search hits', () => {
      const payload = {
        memories: [
          { id: '1', memory: 'First', score: 0.9 },
          { id: '2', memory: 'Second', score: 0.8 },
        ],
      };

      const hits = extractHits(payload);

      expect(hits).toHaveLength(2);
      expect(hits[0].id).toBe('1');
      expect(hits[0].content).toBe('First');
      expect(hits[0].score).toBe(0.9);
    });

    it('filters out invalid records', () => {
      const payload = {
        memories: [{ id: '1', memory: 'Valid' }, { id: '', memory: 'No ID' }, { id: '2' }, null],
      };

      const hits = extractHits(payload);

      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe('1');
    });

    it('handles empty payload', () => {
      expect(extractHits({})).toHaveLength(0);
      expect(extractHits(null)).toHaveLength(0);
    });
  });

  describe('toHistoryEntry', () => {
    it('converts history entry', () => {
      const entry = {
        id: 'hist-1',
        action: 'create',
        metadata: { source: 'test' },
        new_memory: { text: 'New memory text' },
        old_memory: { text: 'Old memory text' },
        timestamp: '2026-01-01T00:00:00Z',
      };

      const result = toHistoryEntry(entry);

      expect(result?.action).toBe('create');
      expect(result?.timestamp).toBe('2026-01-01T00:00:00Z');
      expect(result?.metadata).toEqual({ source: 'test' });
    });

    it('handles alternative action field names', () => {
      const entry = {
        event: 'update',
        time: '2026-01-02T00:00:00Z',
        content: 'Direct content',
      };

      const result = toHistoryEntry(entry);

      expect(result?.action).toBe('update');
      expect(result?.timestamp).toBe('2026-01-02T00:00:00Z');
      expect(result?.content).toBe('Direct content');
    });

    it('returns null for empty object', () => {
      expect(toHistoryEntry({})).toBeNull();
    });

    it('returns null for non-object', () => {
      expect(toHistoryEntry(null)).toBeNull();
      expect(toHistoryEntry('string')).toBeNull();
    });
  });

  describe('extractHistory', () => {
    it('extracts from history array', () => {
      const payload = {
        history: [
          { action: 'create', timestamp: '2026-01-01' },
          { action: 'update', timestamp: '2026-01-02' },
        ],
      };

      const result = extractHistory(payload);

      expect(result).toHaveLength(2);
      expect(result[0].action).toBe('create');
    });

    it('extracts from results array', () => {
      const payload = {
        results: [{ action: 'delete' }],
      };

      const result = extractHistory(payload);
      expect(result).toHaveLength(1);
    });

    it('handles array payload', () => {
      const payload = [{ action: 'create' }, { action: 'update' }];
      const result = extractHistory(payload);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for no history', () => {
      expect(extractHistory({})).toHaveLength(0);
    });
  });

  describe('extractId', () => {
    it('extracts ID from flat structure', () => {
      expect(extractId({ id: 'mem-123' })).toBe('mem-123');
    });

    it('extracts memory_id', () => {
      expect(extractId({ memory_id: 'mem-456' })).toBe('mem-456');
    });

    it('extracts from nested memory', () => {
      expect(extractId({ memory: { id: 'mem-789' } })).toBe('mem-789');
    });

    it('extracts from array', () => {
      const payload = [
        { id: 'first', memory: 'test' },
        { id: 'second', memory: 'test2' },
      ];
      expect(extractId(payload)).toBe('first');
    });

    it('extracts from results', () => {
      const payload = { results: [{ id: 'result-id', memory: 'test' }] };
      expect(extractId(payload)).toBe('result-id');
    });

    it('returns null for missing ID', () => {
      expect(extractId({ foo: 'bar' })).toBeNull();
    });
  });

  describe('extractListMeta', () => {
    it('extracts pagination metadata', () => {
      const payload = {
        total: 100,
        page: 2,
        page_size: 10,
      };

      const result = extractListMeta(payload, 1, 10);

      expect(result.total).toBe(100);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
    });

    it('extracts from nested pagination', () => {
      const payload = {
        pagination: {
          total: 50,
          current_page: 3,
          per_page: 20,
        },
      };

      const result = extractListMeta(payload, 1, 10);

      expect(result.total).toBe(50);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('handles alternative field names', () => {
      const payload = {
        total_count: 75,
        current_page: 4,
        page_size: 15,
      };

      const result = extractListMeta(payload, 1, 10);

      expect(result.total).toBe(75);
      expect(result.page).toBe(4);
      expect(result.pageSize).toBe(15);
    });

    it('uses fallback values', () => {
      const payload = { foo: 'bar' };
      const result = extractListMeta(payload, 5, 25);

      expect(result.total).toBe(0);
      expect(result.page).toBe(5);
      expect(result.pageSize).toBe(25);
    });

    it('handles count page_number limit fields', () => {
      const payload = {
        count: 75,
        page_number: 4,
        limit: 15,
      };

      const result = extractListMeta(payload, 1, 10);

      expect(result.total).toBe(75);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });
  });
});
