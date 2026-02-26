import {
  normalizeLookupText,
  detectMentionedCounterpart,
} from '@/server/knowledge/retrieval/query/intentDetector';
import {
  BINARY_RECALL_QUERY_PATTERN,
  GENERIC_QUERY_TOKENS,
  NEGATION_SIGNAL_PATTERN,
} from '../constants';
import type { StoredMessage } from '@/server/channels/messages/repository';

export function isBinaryRecallQuery(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  return BINARY_RECALL_QUERY_PATTERN.test(normalized);
}

export function extractQueryEvidenceTokens(value: string): string[] {
  const normalized = normalizeLookupText(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  const specific = tokens.filter((token) => !GENERIC_QUERY_TOKENS.has(token));
  return specific.length > 0 ? specific : tokens;
}

export function hasEvidenceTokenOverlap(text: string, tokens: string[]): boolean {
  const normalized = normalizeLookupText(text);
  if (!normalized || tokens.length === 0) return false;
  return tokens.some((token) => normalized.includes(token));
}

export function detectBinaryRecallConflict(
  messages: StoredMessage[],
  query: string,
): { hasConflict: boolean; userSeqs: number[]; agentSeqs: number[] } {
  if (!isBinaryRecallQuery(query)) {
    return { hasConflict: false, userSeqs: [], agentSeqs: [] };
  }

  const tokens = extractQueryEvidenceTokens(query);
  if (tokens.length === 0) {
    return { hasConflict: false, userSeqs: [], agentSeqs: [] };
  }

  const relevant = messages.filter((message) => hasEvidenceTokenOverlap(message.content, tokens));
  const userMessages = relevant.filter((message) => message.role === 'user');
  const agentMessages = relevant.filter((message) => message.role === 'agent');

  const userSeqs = new Set<number>();
  const agentSeqs = new Set<number>();
  for (const userMessage of userMessages) {
    for (const agentMessage of agentMessages) {
      const userHasNegation = NEGATION_SIGNAL_PATTERN.test(
        normalizeLookupText(userMessage.content),
      );
      const agentHasNegation = NEGATION_SIGNAL_PATTERN.test(
        normalizeLookupText(agentMessage.content),
      );
      if (userHasNegation === agentHasNegation) {
        continue;
      }

      const userSeq = Math.floor(Number(userMessage.seq || 0));
      const agentSeq = Math.floor(Number(agentMessage.seq || 0));
      if (userSeq > 0) userSeqs.add(userSeq);
      if (agentSeq > 0) agentSeqs.add(agentSeq);
    }
  }

  return {
    hasConflict: userSeqs.size > 0 && agentSeqs.size > 0,
    userSeqs: [...userSeqs].sort((a, b) => a - b),
    agentSeqs: [...agentSeqs].sort((a, b) => a - b),
  };
}

// Re-export for convenience
export { normalizeLookupText, detectMentionedCounterpart };
