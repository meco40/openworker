interface ConversationSearchMessage {
  id: string;
  content: string;
}

export interface MatchRange {
  start: number;
  end: number;
}

export function findCaseInsensitiveMatchRanges(text: string, query: string): MatchRange[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const source = String(text || '');
  const normalizedSource = source.toLowerCase();
  const ranges: MatchRange[] = [];
  let fromIndex = 0;

  while (fromIndex <= normalizedSource.length - normalizedQuery.length) {
    const at = normalizedSource.indexOf(normalizedQuery, fromIndex);
    if (at < 0) break;
    ranges.push({
      start: at,
      end: at + normalizedQuery.length,
    });
    fromIndex = at + normalizedQuery.length;
  }

  return ranges;
}

export function countConversationSearchMatches(
  messages: ConversationSearchMessage[],
  query: string,
): number {
  return messages.reduce(
    (total, message) => total + findCaseInsensitiveMatchRanges(message.content || '', query).length,
    0,
  );
}

export function stepConversationSearchIndex(
  currentIndex: number,
  totalMatches: number,
  direction: 'next' | 'prev',
): number {
  if (totalMatches <= 0) return 0;
  if (direction === 'next') {
    return (currentIndex + 1) % totalMatches;
  }
  return (currentIndex - 1 + totalMatches) % totalMatches;
}
