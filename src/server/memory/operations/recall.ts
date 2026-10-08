import type { Mem0Client } from '@/server/memory/mem0';
import type { MemoryType } from '@/core/memory/types';
import type { MemoryRecallResult } from '../types';
import { MEM0_SCORE_THRESHOLD } from '../constants';
import { normalizeMem0Score } from '../utils/scoring';
import { isRulesLikeQuery, containsRulesWord } from '../utils/queryUtils';
import { toMemoryNode, toMemoryNodeFromHit } from '../mappers/nodeMappers';
import { resolveUserId } from '../validators/typeValidators';
import { formatRecallContextLine } from '../formatters/contextFormatter';
import {
  isActiveMemoryMetadata,
  publishMemoryLifecycleChange,
  resolveLifecycleStatus,
} from '@/server/memory/lifecycle';

function isRecallActive(
  node: ReturnType<typeof toMemoryNode>,
  input: { userId: string; personaId: string },
): boolean {
  const resolved = resolveLifecycleStatus(node.metadata);
  if (resolved.derivedSignal === 'time_expired') {
    publishMemoryLifecycleChange({
      memoryId: node.id,
      userId: input.userId,
      personaId: input.personaId,
      status: 'stale',
      signal: 'time_expired',
    });
  }
  return isActiveMemoryMetadata(node.metadata);
}

export interface RecallOptions {
  personaId: string;
  workspaceId?: string;
  query: string;
  limit?: number;
  userId?: string;
  mode?: 'semantic' | 'lexical';
  memoryTypes?: MemoryType[];
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
    // Conjugated verb pairs must be replaced before the pronoun itself.
    const expanded = query
      .replace(/\bkannst du\b/gi, 'kann ich')
      .replace(/\bdu kannst\b/gi, 'ich kann')
      .replace(/\bhast du\b/gi, 'habe ich')
      .replace(/\bdu hast\b/gi, 'ich habe')
      .replace(/\bbist du\b/gi, 'bin ich')
      .replace(/\bdu bist\b/gi, 'ich bin')
      .replace(/\bwillst du\b/gi, 'will ich')
      .replace(/\bdu willst\b/gi, 'ich will')
      .replace(/\bmagst du\b/gi, 'mag ich')
      .replace(/\bdu magst\b/gi, 'ich mag')
      .replace(/\bmöchtest du\b/gi, 'möchte ich')
      .replace(/\bdu möchtest\b/gi, 'ich möchte')
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
    const expanded = query
      .replace(/\bkann ich\b/gi, 'kannst du')
      .replace(/\bich kann\b/gi, 'du kannst')
      .replace(/\bhabe ich\b/gi, 'hast du')
      .replace(/\bich habe\b/gi, 'du hast')
      .replace(/\bbin ich\b/gi, 'bist du')
      .replace(/\bich bin\b/gi, 'du bist')
      .replace(/\bwill ich\b/gi, 'willst du')
      .replace(/\bich will\b/gi, 'du willst')
      .replace(/\bmag ich\b/gi, 'magst du')
      .replace(/\bich mag\b/gi, 'du magst')
      .replace(/\bmöchte ich\b/gi, 'möchtest du')
      .replace(/\bich möchte\b/gi, 'du möchtest')
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

async function listLexicalCandidates(input: {
  client: Mem0Client;
  userId: string;
  personaId: string;
  workspaceId?: string;
  queryVariants: string[];
  allowedTypes: Set<MemoryType> | null;
  pageSize: number;
}) {
  const queries = input.queryVariants.length > 0 ? input.queryVariants : [undefined];
  const types: Array<MemoryType | undefined> = input.allowedTypes
    ? [...input.allowedTypes]
    : [undefined];
  const pages = await Promise.all(
    types.flatMap((type) =>
      queries.map((query) =>
        input.client.listMemories({
          userId: input.userId,
          personaId: input.personaId,
          workspaceId: input.workspaceId,
          page: 1,
          pageSize: input.pageSize,
          query,
          type,
        }),
      ),
    ),
  );
  const byId = new Map<string, (typeof pages)[number]['memories'][number]>();
  for (const memory of pages.flatMap((page) => page.memories)) {
    if (!byId.has(memory.id)) byId.set(memory.id, memory);
  }
  return Array.from(byId.values());
}

export async function recallDetailed(
  client: Mem0Client,
  options: RecallOptions,
): Promise<MemoryRecallResult> {
  const {
    personaId,
    workspaceId,
    query,
    limit = 3,
    userId,
    mode = 'semantic',
    memoryTypes,
  } = options;
  const scopedUserId = resolveUserId(userId);
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 3)));
  const allowedTypes = memoryTypes?.length ? new Set(memoryTypes) : null;
  const lowered = query.trim().toLowerCase();
  const rulesLikeQuery = isRulesLikeQuery(lowered);
  const queryVariants = expandSelfReferenceQuery(query)
    .split('|')
    .map((variant) => variant.trim().toLowerCase())
    .filter((variant) => variant.length > 0);

  if (mode === 'lexical') {
    const listed = await listLexicalCandidates({
      client,
      userId: scopedUserId,
      personaId,
      workspaceId,
      queryVariants,
      allowedTypes,
      pageSize: Math.max(25, safeLimit * 4),
    });

    const lexicalMatches = listed
      .map((record) => toMemoryNode(record))
      .filter((node) => !allowedTypes || allowedTypes.has(node.type))
      .filter((node) => isRecallActive(node, { userId: scopedUserId, personaId }))
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
    workspaceId,
    // PostgreSQL semantic search uses the original natural-language query;
    // perspective variants belong to the lexical fallback and would otherwise
    // degrade the embedding while preventing cross-source request deduplication.
    query: client.provider === 'postgres' ? query : expandedQuery,
    limit: allowedTypes ? Math.max(safeLimit * 4, 20) : safeLimit,
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
    .filter((entry) => !allowedTypes || allowedTypes.has(entry.node.type))
    .filter((entry) => isRecallActive(entry.node, { userId: scopedUserId, personaId }))
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  const hasRulesFocusedMatch = matches.some((entry) => containsRulesWord(entry.node.content));

  if (matches.length === 0 || (rulesLikeQuery && !hasRulesFocusedMatch)) {
    const listed = await listLexicalCandidates({
      client,
      userId: scopedUserId,
      personaId,
      workspaceId,
      queryVariants,
      allowedTypes,
      pageSize: Math.max(10, safeLimit),
    });

    const lexicalMatches = listed
      .map((record) => toMemoryNode(record))
      .filter((node) => !allowedTypes || allowedTypes.has(node.type))
      .filter((node) => isRecallActive(node, { userId: scopedUserId, personaId }))
      .filter((node) => {
        if (!lowered) return true;
        if (queryVariants.some((variant) => node.content.toLowerCase().includes(variant))) {
          return true;
        }
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
