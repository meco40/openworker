import { STOP_WORDS } from '@/server/channels/messages/repository/constants/stopWords';

/**
 * Converts a user query string into an FTS5 MATCH expression.
 * - Otherwise, OR all non-stopword tokens for recall-friendly matching.
 * - German/English stop words are stripped to avoid overly restrictive queries.
 * - Keeps prefix wildcard semantics for trailing '*' (e.g. Type*).
 * - Never forwards raw punctuation-heavy input to MATCH to avoid syntax errors.
 */
export function buildFtsQuery(raw: string): string {
  // Extract safe token terms with optional trailing wildcard (Type*).
  // Leading/infix punctuation (e.g. *max*, (a:b), quotes) is stripped by design.
  const allTokens = (raw.match(/[\p{L}\p{N}]+(?:\*)?/gu) || [])
    .map((token) => {
      const hasWildcard = token.endsWith('*');
      const base = hasWildcard ? token.slice(0, -1) : token;
      return hasWildcard && base ? `${base}*` : base;
    })
    .filter(Boolean);
  const tokens = allTokens.filter((t) => !STOP_WORDS.has(t.replace(/\*$/, '').toLowerCase()));
  if (tokens.length === 0) {
    // All words were stop words — fall back to original tokens
    return allTokens.length <= 1 ? (allTokens[0] ?? raw) : allTokens.join(' AND ');
  }
  if (tokens.length === 1) return tokens[0];
  // Use OR semantics for recall — BM25 ranking surfaces multi-match hits first
  return tokens.join(' OR ');
}
