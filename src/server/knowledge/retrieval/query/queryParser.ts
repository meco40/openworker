import { normalizeLookupText } from './intentDetector';

export function tokenizeQueryForRanking(query: string): string[] {
  const normalized = normalizeLookupText(query);
  const stopwords = new Set([
    'die',
    'der',
    'das',
    'ein',
    'eine',
    'und',
    'oder',
    'mit',
    'von',
    'zu',
    'an',
    'mir',
    'du',
    'ich',
    'was',
    'wie',
    'wann',
    'warum',
    'wieso',
    'nenne',
    'sage',
    'sag',
    'zeige',
    'bitte',
  ]);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopwords.has(token));
}
