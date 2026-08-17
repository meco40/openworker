import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELETE_ALL_CONFIRM_TOKEN,
  ValidationError,
  dedupeById,
  isDeleteAllConfirmed,
  parseBulkBody,
  parseFlag,
  parseMemoryNodeId,
  parseOptionalType,
  parsePersonaId,
  parseRecallArgs,
  parseStoreArgs,
  parseUpdateBody,
  rankNodeTimestamp,
  resolveMemoryReadUserScopes,
} from '@/server/memory/api/shared';

vi.mock('@/server/channels/messages/runtime', () => ({
  getMessageRepository: vi.fn(),
}));

import { getMessageRepository } from '@/server/channels/messages/runtime';

describe('memory/api/shared branch coverage', () => {
  describe('getReadyMemoryService', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('throws MemoryRuntimeUnavailableError when guarded service is null', async () => {
      vi.doMock('@/server/memory/runtime', () => ({
        getMemoryServiceIfReady: () => null,
        getMemoryService: () => ({ ready: true }),
      }));
      const { getReadyMemoryService: getReady, MemoryRuntimeUnavailableError: Err } =
        await import('@/server/memory/api/shared');
      expect(() => getReady()).toThrow(Err);
    });

    it('returns guarded service when available', async () => {
      const guarded = { ready: true, source: 'guarded' };
      vi.doMock('@/server/memory/runtime', () => ({
        getMemoryServiceIfReady: () => guarded,
        getMemoryService: () => ({ ready: false }),
      }));
      const { getReadyMemoryService: getReady } = await import('@/server/memory/api/shared');
      expect(getReady()).toBe(guarded);
    });

    it('falls back to getMemoryService when no guarded helper exists', async () => {
      const fallback = { ready: true, source: 'fallback' };
      vi.doMock('@/server/memory/runtime', () => ({
        getMemoryService: () => fallback,
      }));
      const { getReadyMemoryService: getReady } = await import('@/server/memory/api/shared');
      expect(getReady()).toBe(fallback);
    });
  });

  describe('parseStoreArgs', () => {
    it('parses valid store args with default importance', () => {
      const result = parseStoreArgs({ personaId: 'p1', type: 'fact', content: 'hello' });
      expect(result).toEqual({ personaId: 'p1', type: 'fact', content: 'hello', importance: 3 });
    });

    it('clamps importance to [1,5]', () => {
      expect(
        parseStoreArgs({ personaId: 'p1', type: 'fact', content: 'x', importance: 99 }).importance,
      ).toBe(5);
      expect(
        parseStoreArgs({ personaId: 'p1', type: 'fact', content: 'x', importance: -5 }).importance,
      ).toBe(1);
      expect(
        parseStoreArgs({ personaId: 'p1', type: 'fact', content: 'x', importance: 2.6 }).importance,
      ).toBe(3);
    });

    it('uses default importance 3 for non-numeric', () => {
      expect(
        parseStoreArgs({ personaId: 'p1', type: 'fact', content: 'x', importance: 'abc' })
          .importance,
      ).toBe(3);
    });

    it('throws on invalid type', () => {
      expect(() => parseStoreArgs({ personaId: 'p1', type: 'bogus', content: 'x' })).toThrow(
        ValidationError,
      );
    });

    it('throws on empty content', () => {
      expect(() => parseStoreArgs({ personaId: 'p1', type: 'fact', content: '  ' })).toThrow(
        ValidationError,
      );
    });
  });

  describe('parseRecallArgs', () => {
    it('parses valid recall args with default limit 3', () => {
      expect(parseRecallArgs({ personaId: 'p1', query: 'q' })).toEqual({
        personaId: 'p1',
        query: 'q',
        limit: 3,
      });
    });

    it('clamps limit to [1,20]', () => {
      expect(parseRecallArgs({ personaId: 'p1', query: 'q', limit: 99 }).limit).toBe(20);
      expect(parseRecallArgs({ personaId: 'p1', query: 'q', limit: 0 }).limit).toBe(1);
      expect(parseRecallArgs({ personaId: 'p1', query: 'q', limit: 5.9 }).limit).toBe(5);
    });

    it('uses default limit 3 for non-numeric', () => {
      expect(parseRecallArgs({ personaId: 'p1', query: 'q', limit: 'x' }).limit).toBe(3);
    });

    it('throws on empty query', () => {
      expect(() => parseRecallArgs({ personaId: 'p1', query: '  ' })).toThrow(ValidationError);
    });
  });

  describe('parsePersonaId / parseMemoryNodeId', () => {
    it('throws on empty personaId', () => {
      expect(() => parsePersonaId('  ')).toThrow(ValidationError);
    });

    it('returns trimmed personaId', () => {
      expect(parsePersonaId('  p1  ')).toBe('p1');
    });

    it('throws on empty node id', () => {
      expect(() => parseMemoryNodeId('  ')).toThrow(ValidationError);
    });

    it('returns trimmed node id', () => {
      expect(parseMemoryNodeId('  n1  ')).toBe('n1');
    });
  });

  describe('parseUpdateBody', () => {
    it('parses type update', () => {
      expect(parseUpdateBody({ personaId: 'p1', id: 'n1', type: 'lesson' })).toEqual({
        personaId: 'p1',
        id: 'n1',
        type: 'lesson',
      });
    });

    it('throws on invalid type', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', type: 'bogus' })).toThrow(
        ValidationError,
      );
    });

    it('parses content update', () => {
      expect(parseUpdateBody({ personaId: 'p1', id: 'n1', content: 'new' })).toEqual({
        personaId: 'p1',
        id: 'n1',
        content: 'new',
      });
    });

    it('throws on empty content', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', content: '  ' })).toThrow(
        ValidationError,
      );
    });

    it('parses importance update with clamping', () => {
      expect(parseUpdateBody({ personaId: 'p1', id: 'n1', importance: 7 }).importance).toBe(5);
      expect(parseUpdateBody({ personaId: 'p1', id: 'n1', importance: 0 }).importance).toBe(1);
    });

    it('throws on non-numeric importance', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', importance: 'x' })).toThrow(
        ValidationError,
      );
    });

    it('parses expectedVersion combined with content', () => {
      expect(
        parseUpdateBody({ personaId: 'p1', id: 'n1', content: 'new', expectedVersion: 2 })
          .expectedVersion,
      ).toBe(2);
    });

    it('throws on invalid expectedVersion', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', expectedVersion: 0 })).toThrow(
        ValidationError,
      );
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', expectedVersion: 'x' })).toThrow(
        ValidationError,
      );
    });

    it('parses restoreIndex', () => {
      expect(parseUpdateBody({ personaId: 'p1', id: 'n1', restoreIndex: 1 }).restoreIndex).toBe(1);
    });

    it('throws on invalid restoreIndex', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', restoreIndex: -1 })).toThrow(
        ValidationError,
      );
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1', restoreIndex: 'x' })).toThrow(
        ValidationError,
      );
    });

    it('throws when restoreIndex combined with other updates', () => {
      expect(() =>
        parseUpdateBody({ personaId: 'p1', id: 'n1', restoreIndex: 1, type: 'fact' }),
      ).toThrow(ValidationError);
    });

    it('throws when no fields to update', () => {
      expect(() => parseUpdateBody({ personaId: 'p1', id: 'n1' })).toThrow(ValidationError);
    });
  });

  describe('parseFlag', () => {
    it('returns true for truthy values', () => {
      expect(parseFlag('1')).toBe(true);
      expect(parseFlag('true')).toBe(true);
      expect(parseFlag('yes')).toBe(true);
      expect(parseFlag('on')).toBe(true);
      expect(parseFlag(' TRUE ')).toBe(true);
    });

    it('returns false for falsy values', () => {
      expect(parseFlag('0')).toBe(false);
      expect(parseFlag('false')).toBe(false);
      expect(parseFlag('no')).toBe(false);
      expect(parseFlag('off')).toBe(false);
      expect(parseFlag('')).toBe(false);
    });
  });

  describe('parseOptionalType', () => {
    it('returns undefined for empty or "all"', () => {
      expect(parseOptionalType('')).toBeUndefined();
      expect(parseOptionalType('all')).toBeUndefined();
    });

    it('returns valid type', () => {
      expect(parseOptionalType('fact')).toBe('fact');
    });

    it('throws on invalid type', () => {
      expect(() => parseOptionalType('bogus')).toThrow(ValidationError);
    });
  });

  describe('parseBulkBody', () => {
    it('parses delete action', () => {
      const result = parseBulkBody({ personaId: 'p1', ids: ['a', 'b'], action: 'delete' });
      expect(result).toEqual({ personaId: 'p1', ids: ['a', 'b'], action: 'delete', updates: {} });
    });

    it('dedupes and trims ids', () => {
      const result = parseBulkBody({
        personaId: 'p1',
        ids: [' a ', 'a', '  ', 'b'],
        action: 'delete',
      });
      expect(result.ids).toEqual(['a', 'b']);
    });

    it('throws on empty ids', () => {
      expect(() => parseBulkBody({ personaId: 'p1', ids: [], action: 'delete' })).toThrow(
        ValidationError,
      );
      expect(() => parseBulkBody({ personaId: 'p1', ids: ['  '], action: 'delete' })).toThrow(
        ValidationError,
      );
    });

    it('throws on invalid action', () => {
      expect(() => parseBulkBody({ personaId: 'p1', ids: ['a'], action: 'bogus' })).toThrow(
        ValidationError,
      );
    });

    it('parses update action with type', () => {
      const result = parseBulkBody({ personaId: 'p1', ids: ['a'], action: 'update', type: 'fact' });
      expect(result.updates.type).toBe('fact');
    });

    it('parses update action with importance', () => {
      const result = parseBulkBody({
        personaId: 'p1',
        ids: ['a'],
        action: 'update',
        importance: 4,
      });
      expect(result.updates.importance).toBe(4);
    });

    it('throws on update without fields', () => {
      expect(() => parseBulkBody({ personaId: 'p1', ids: ['a'], action: 'update' })).toThrow(
        ValidationError,
      );
    });
  });

  describe('isDeleteAllConfirmed', () => {
    it('returns true for exact token', () => {
      expect(isDeleteAllConfirmed(DELETE_ALL_CONFIRM_TOKEN)).toBe(true);
      expect(isDeleteAllConfirmed(` ${DELETE_ALL_CONFIRM_TOKEN} `)).toBe(true);
    });

    it('returns false otherwise', () => {
      expect(isDeleteAllConfirmed('other')).toBe(false);
      expect(isDeleteAllConfirmed('')).toBe(false);
    });
  });

  describe('resolveMemoryReadUserScopes', () => {
    it('returns empty for empty userId', () => {
      expect(resolveMemoryReadUserScopes('', 'p1')).toEqual([]);
    });

    it('returns single scope for non-legacy user', () => {
      expect(resolveMemoryReadUserScopes('user-1', 'p1')).toEqual(['user-1']);
    });

    it('returns legacy scope plus channel scopes for legacy user', () => {
      const conversations = [
        { channelType: 'telegram', externalChatId: 'chat-1', personaId: 'p1' },
        { channelType: 'webchat', externalChatId: 'chat-2', personaId: 'p1' },
        { channelType: 'discord', externalChatId: 'chat-3', personaId: 'other' },
        { channelType: 'slack', externalChatId: 'chat-4', personaId: null },
      ];
      vi.mocked(getMessageRepository).mockReturnValue({
        listConversations: vi.fn(() => conversations),
      } as never);
      const result = resolveMemoryReadUserScopes('legacy-local-user', 'p1');
      expect(result).toContain('legacy-local-user');
      expect(result).toContain('channel:telegram:chat-1');
      expect(result).not.toContain('channel:webchat:chat-2');
      expect(result).not.toContain('channel:discord:chat-3');
      expect(result).toContain('channel:slack:chat-4');
    });

    it('handles repository errors gracefully', () => {
      vi.mocked(getMessageRepository).mockReturnValue({
        listConversations: vi.fn(() => {
          throw new Error('db down');
        }),
      } as never);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveMemoryReadUserScopes('legacy-local-user', 'p1');
      expect(result).toEqual(['legacy-local-user']);
      consoleWarnSpy.mockRestore();
    });
  });

  describe('dedupeById', () => {
    it('dedupes by id keeping last', () => {
      const rows = [
        { id: 'a', v: 1 },
        { id: 'b', v: 2 },
        { id: 'a', v: 3 },
      ];
      const result = dedupeById(rows);
      expect(result).toHaveLength(2);
      expect(result.find((r) => r.id === 'a')?.v).toBe(3);
    });

    it('skips rows without id', () => {
      const rows = [{ id: 'a' }, { id: '' }, { id: 'b' }];
      expect(dedupeById(rows)).toHaveLength(2);
    });
  });

  describe('rankNodeTimestamp', () => {
    it('returns parsed timestamp', () => {
      const node = { metadata: { lastVerified: '2026-01-01T00:00:00.000Z' } };
      expect(rankNodeTimestamp(node)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    });

    it('returns 0 for invalid or missing timestamp', () => {
      expect(rankNodeTimestamp({ metadata: { lastVerified: 'bogus' } })).toBe(0);
      expect(rankNodeTimestamp({ metadata: {} })).toBe(0);
      expect(rankNodeTimestamp({})).toBe(0);
    });
  });
});
