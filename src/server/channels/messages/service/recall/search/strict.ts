/**
 * Strict evidence search operations
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveMemoryUserIdCandidates } from '@/server/memory/userScope';
import { MEMORY_RECALL_LIMIT } from '../../types';
import { COMMITMENT_TOKENS, RECALL_QUERY_STOP_WORDS, TIME_TOKENS } from '../constants';
import type { StrictRecallCandidate } from '../types';
import {
  applyRecencyBoost,
  countHits,
  dedupeCandidates,
  hasAnyToken,
  normalizeForMatch,
  tokenizeNormalized,
} from '../utils';

/**
 * Build candidates from chat hits
 */
function buildChatCandidates(
  chatHits: StoredMessage[],
  topicTokens: string[],
  queryTimeTokens: string[],
): StrictRecallCandidate[] {
  const candidates: StrictRecallCandidate[] = [];

  for (const hit of chatHits) {
    const text = String(hit.content || '').trim();
    if (!text) continue;
    const normalized = normalizeForMatch(text);
    const topicHits = countHits(normalized, topicTokens);
    const timeHits = countHits(normalized, queryTimeTokens);
    const sourceWeight = hit.role === 'user' ? 2.8 : hit.role === 'agent' ? 1.6 : 1.2;
    const commitmentBonus = hasAnyToken(normalized, COMMITMENT_TOKENS) ? 0.5 : 0;
    candidates.push({
      source: 'chat',
      role: hit.role,
      text,
      createdAt: hit.createdAt,
      normalized,
      topicHits,
      timeHits,
      score: sourceWeight + topicHits * 4 + timeHits * 0.8 + commitmentBonus,
    });
  }

  return candidates;
}

/**
 * Build candidates from memory matches
 */
function buildMemoryCandidates(
  memoryRecalled: {
    context: string;
    matches: Array<{ node: { id: string; content?: string; timestamp?: string } }>;
  },
  topicTokens: string[],
  queryTimeTokens: string[],
): StrictRecallCandidate[] {
  const candidates: StrictRecallCandidate[] = [];

  for (const match of memoryRecalled.matches || []) {
    const text = String(match?.node?.content || '').trim();
    if (!text) continue;
    const normalized = normalizeForMatch(text);
    const topicHits = countHits(normalized, topicTokens);
    const timeHits = countHits(normalized, queryTimeTokens);
    const commitmentBonus = hasAnyToken(normalized, COMMITMENT_TOKENS) ? 0.4 : 0;
    const timestampValue =
      typeof match.node?.timestamp === 'string' ? match.node.timestamp : undefined;
    candidates.push({
      source: 'memory',
      role: 'memory',
      text,
      createdAt: timestampValue,
      normalized,
      topicHits,
      timeHits,
      score: 2.2 + topicHits * 4 + timeHits * 0.6 + commitmentBonus,
    });
  }

  return candidates;
}

/**
 * Recall detailed memory for strict evidence search
 */
async function recallFromMemoryDetailed(
  memoryUserIds: string[],
  conversation: Conversation,
  userInput: string,
  options: { mode: 'semantic' | 'lexical' },
): Promise<{ context: string; matches: Array<{ node: { id: string; content?: string } }> }> {
  const personaId = conversation.personaId!;
  for (const userIdCandidate of memoryUserIds) {
    try {
      const recalled = await getMemoryService().recallDetailed(
        personaId,
        userInput,
        MEMORY_RECALL_LIMIT,
        userIdCandidate,
        { mode: options.mode },
      );
      if (recalled.matches.length > 0) {
        return recalled;
      }
    } catch (error) {
      console.error('Memory strict recall failed:', error);
    }
  }
  return { context: 'No relevant memories found.', matches: [] };
}

export interface StrictSearchResult {
  candidates: StrictRecallCandidate[];
  deduped: StrictRecallCandidate[];
  relevant: StrictRecallCandidate[];
  sortedRelevant: StrictRecallCandidate[];
  sortedContext: StrictRecallCandidate[];
  winner: StrictRecallCandidate | undefined;
  runnerUp: StrictRecallCandidate | undefined;
  hasConflict: boolean;
  topicTokens: string[];
}

/**
 * Perform strict evidence search combining chat and memory sources
 */
export async function performStrictSearch(
  conversation: Conversation,
  userInput: string,
  chatHits: StoredMessage[],
): Promise<StrictSearchResult> {
  const normalizedQuery = normalizeForMatch(userInput);
  const queryTokens = tokenizeNormalized(normalizedQuery);
  const topicTokens = queryTokens.filter((token) => !RECALL_QUERY_STOP_WORDS.has(token));
  const queryTimeTokens = queryTokens.filter((token) => TIME_TOKENS.has(token));

  const memoryUserIds = resolveMemoryUserIdCandidates({
    userId: conversation.userId,
    channelType: conversation.channelType,
    externalChatId: conversation.externalChatId || 'default',
  });

  const memoryRecalled = await recallFromMemoryDetailed(memoryUserIds, conversation, userInput, {
    mode: 'lexical',
  });

  const candidates: StrictRecallCandidate[] = [
    ...buildChatCandidates(chatHits, topicTokens, queryTimeTokens),
    ...buildMemoryCandidates(memoryRecalled, topicTokens, queryTimeTokens),
  ];

  applyRecencyBoost(candidates);

  const deduped = dedupeCandidates(candidates);
  const relevant = topicTokens.length
    ? deduped.filter((candidate) => candidate.topicHits > 0)
    : deduped;
  const sortedRelevant = [...relevant].sort((a, b) => b.score - a.score);
  const sortedContext = [...deduped]
    .filter((candidate) => candidate.timeHits > 0)
    .sort((a, b) => b.score - a.score);

  const winner = sortedRelevant[0];
  const runnerUp = sortedRelevant[1];
  const hasConflict = Boolean(runnerUp && Math.abs(winner.score - runnerUp.score) < 0.8);

  return {
    candidates,
    deduped,
    relevant,
    sortedRelevant,
    sortedContext,
    winner,
    runnerUp,
    hasConflict,
    topicTokens,
  };
}

export { buildChatCandidates, buildMemoryCandidates, recallFromMemoryDetailed };
