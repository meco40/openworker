import type { Mem0Client } from '@/server/memory/mem0Client';
import type { MemoryRecallResult } from '../types';
import { MEM0_SCORE_THRESHOLD } from '../constants';
import { normalizeMem0Score } from '../utils/scoring';
import { isRulesLikeQuery, containsRulesWord } from '../utils/queryUtils';
import { toMemoryNode, toMemoryNodeFromHit } from '../mappers/nodeMappers';
import { resolveUserId } from '../validators/typeValidators';
import { formatRecallContextLine } from '../formatters/contextFormatter';

export interface RecallOptions {
  personaId: string;
  query: string;
  limit?: number;
  userId?: string;
  mode?: 'semantic' | 'lexical';
}

/**
 * Expands queries with self-references to improve matching.
 * When user asks "du...", also search for "ich..." memories and vice versa.
 */
function expandSelfReferenceQuery(query: string): string {
  const normalized = query.toLowerCase().trim();

  // Check if query contains self-reference terms
  const hasDu = /\b(du|dein|deine|dir|dich)\b/.test(normalized);
  const hasIch = /\b(ich|mein|meine|mir|mich)\b/.test(normalized);

  if (!hasDu && !hasIch) return query;

  // Build expanded query with both directions
  const expansions: string[] = [query];

  if (hasDu) {
    // Expand du → ich (all cases)
    const expanded = query
      .replace(/\bdu\b/gi, 'ich')
      .replace(/\bdein\b/gi, 'mein')
      .replace(/\bdeine\b/gi, 'meine')
      .replace(/\bdeinem\b/gi, 'meinem')
      .replace(/\bdeinen\b/gi, 'meinen')
      .replace(/\bdeiner\b/gi, 'meiner')
      .replace(/\bdeines\b/gi, 'meines')
      .replace(/\bdir\b/gi, 'mir')
      .replace(/\bdich\b/gi, 'mich');
    expansions.push(expanded);
  }

  if (hasIch) {
    // Expand ich → du (all cases, for completeness)
    const expanded = query
      .replace(/\bich\b/gi, 'du')
      .replace(/\bmein\b/gi, 'dein')
      .replace(/\bmeine\b/gi, 'deine')
      .replace(/\bmeinem\b/gi, 'deinem')
      .replace(/\bmeinen\b/gi, 'deinen')
      .replace(/\bmeiner\b/gi, 'deiner')
      .replace(/\bmeines\b/gi, 'deines')
      .replace(/\bmir\b/gi, 'dir')
      .replace(/\bmich\b/gi, 'dich');
    expansions.push(expanded);
  }

  return expansions.join(' | ');
}

export async function recallDetailed(
  client: Mem0Client,
  options: RecallOptions,
): Promise<MemoryRecallResult> {
  const { personaId, query, limit = 3, userId, mode = 'semantic' } = options;
  const scopedUserId = resolveUserId(userId);
  const safeLimit = Math.max(1, limit);
  const lowered = query.trim().toLowerCase();
  const rulesLikeQuery = isRulesLikeQuery(lowered);

  if (mode === 'lexical') {
    const listed = await client.listMemories({
      userId: scopedUserId,
      personaId,
      page: 1,
      pageSize: Math.max(25, safeLimit * 4),
      query: query.trim() || undefined,
    });

    const queryVariants = expandSelfReferenceQuery(query)
      .split('|')
      .map((variant) => variant.trim().toLowerCase())
      .filter((variant) => variant.length > 0);

    const lexicalMatches = listed.memories
      .map((record) => toMemoryNode(record))
      .filter((node) => {
        const content = node.content.toLowerCase();
        if (!lowered) return true;
        if (queryVariants.some((variant) => content.includes(variant))) return true;
        if (rulesLikeQuery && containsRulesWord(node.content)) return true;
        return false;
      })
      .slice(0, safeLimit)
      .map((node) => ({
        node,
        similarity: MEM0_SCORE_THRESHOLD,
        score: MEM0_SCORE_THRESHOLD,
      }));

    const context = lexicalMatches.map((result) => formatRecallContextLine(result.node)).join('\n');
    return {
      context: context || 'No relevant memories found.',
      matches: lexicalMatches,
    };
  }

  // Expand query for self-reference matching
  const expandedQuery = expandSelfReferenceQuery(query);

  const hits = await client.searchMemories({
    userId: scopedUserId,
    personaId,
    query: expandedQuery,
    limit: safeLimit,
  });

  let matches = hits
    .map((hit) => {
      const similarity = normalizeMem0Score(hit.score);
      return {
        node: toMemoryNodeFromHit(hit),
        similarity,
        score: similarity,
      };
    })
    .filter((entry) => entry.similarity >= MEM0_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  const hasRulesFocusedMatch = matches.some((entry) => containsRulesWord(entry.node.content));

  if (matches.length === 0 || (rulesLikeQuery && !hasRulesFocusedMatch)) {
    const listed = await client.listMemories({
      userId: scopedUserId,
      personaId,
      page: 1,
      pageSize: Math.max(10, safeLimit),
      query: query.trim() || undefined,
    });

    const lexicalMatches = listed.memories
      .map((record) => toMemoryNode(record))
      .filter((node) => {
        if (!lowered) return true;
        if (node.content.toLowerCase().includes(lowered)) return true;
        if (rulesLikeQuery && containsRulesWord(node.content)) return true;
        return false;
      })
      .slice(0, safeLimit)
      .map((node) => ({
        node,
        similarity: MEM0_SCORE_THRESHOLD,
        score: MEM0_SCORE_THRESHOLD,
      }));

    const merged = [...matches, ...lexicalMatches];
    const seenIds = new Set<string>();
    matches = [];
    for (const entry of merged) {
      if (seenIds.has(entry.node.id)) continue;
      seenIds.add(entry.node.id);
      matches.push(entry);
    }
    matches = matches
      .sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;
        return a.node.content.length - b.node.content.length;
      })
      .slice(0, safeLimit);
  }

  const context = matches.map((result) => formatRecallContextLine(result.node)).join('\n');

  return {
    context: context || 'No relevant memories found.',
    matches,
  };
}

export async function recall(client: Mem0Client, options: RecallOptions): Promise<string> {
  const result = await recallDetailed(client, options);
  return result.context;
}
