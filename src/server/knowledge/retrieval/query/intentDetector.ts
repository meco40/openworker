import { uniqueStrings } from '../utils/arrayUtils';

const RULES_WORD_PATTERN =
  /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i;

export function isRulesIntentQuery(query: string): boolean {
  return RULES_WORD_PATTERN.test(normalizeLookupText(query));
}

export function containsRulesWord(value: string): boolean {
  return RULES_WORD_PATTERN.test(normalizeLookupText(value));
}

export function normalizeLookupText(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectMentionedCounterpart(query: string, candidates: string[]): string | null {
  const queryTokens = new Set(
    normalizeLookupText(query)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
  if (queryTokens.size === 0) return null;

  const orderedCandidates = uniqueStrings(candidates)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const candidate of orderedCandidates) {
    const tokens = normalizeLookupText(candidate)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
    if (tokens.length === 0) continue;
    const allTokensMatch = tokens.every((token) => queryTokens.has(token));
    if (allTokensMatch) return candidate;
  }

  return null;
}

export function isCounterpartMatch(value: string | null | undefined, counterpart: string): boolean {
  const left = normalizeLookupText(String(value || ''));
  const right = normalizeLookupText(counterpart);
  return Boolean(left && right && left === right);
}
