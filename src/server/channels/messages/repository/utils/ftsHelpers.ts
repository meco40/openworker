import { STOP_WORDS } from '@/server/channels/messages/repository/constants/stopWords';

function renderFtsToken(token: string): string {
  if (token.endsWith('*')) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

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
    // If there are no safe tokens at all (punctuation-only input), skip MATCH entirely.
    if (allTokens.length === 0) return '';
    // All safe words were stop words — fall back to the safe token list only.
    return allTokens.length <= 1
      ? renderFtsToken(allTokens[0] ?? '')
      : allTokens.map(renderFtsToken).join(' AND ');
  }
  if (tokens.length === 1) return renderFtsToken(tokens[0]);
  // Use OR semantics for recall — BM25 ranking surfaces multi-match hits first
  return tokens.map(renderFtsToken).join(' OR ');
}
