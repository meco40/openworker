import { describe, expect, it } from 'vitest';
import {
  countConversationSearchMatches,
  findCaseInsensitiveMatchRanges,
  stepConversationSearchIndex,
} from '@/modules/chat/search';

describe('conversation search helpers', () => {
  it('finds case-insensitive match ranges in message text', () => {
    const ranges = findCaseInsensitiveMatchRanges('Hello hello HELLO', 'hello');
    expect(ranges).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it('returns no match ranges for empty or whitespace-only query', () => {
    expect(findCaseInsensitiveMatchRanges('hello', '')).toEqual([]);
    expect(findCaseInsensitiveMatchRanges('hello', '   ')).toEqual([]);
  });

  it('counts total matches across messages in one conversation', () => {
    const total = countConversationSearchMatches(
      [
        { id: 'm1', content: 'alpha beta alpha' },
        { id: 'm2', content: 'no hit' },
        { id: 'm3', content: 'ALPHA' },
      ],
      'alpha',
    );
    expect(total).toBe(3);
  });

  it('supports wrap-around navigation for match index stepping', () => {
    expect(stepConversationSearchIndex(0, 3, 'next')).toBe(1);
    expect(stepConversationSearchIndex(2, 3, 'next')).toBe(0);
    expect(stepConversationSearchIndex(0, 3, 'prev')).toBe(2);
    expect(stepConversationSearchIndex(2, 3, 'prev')).toBe(1);
  });

  it('keeps active index at zero when there are no matches', () => {
    expect(stepConversationSearchIndex(0, 0, 'next')).toBe(0);
    expect(stepConversationSearchIndex(3, 0, 'prev')).toBe(0);
  });
});
