import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SearchMessagesOptions } from '@/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '@/shared/domain/types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveKnowledgeConfig } from '@/server/knowledge/config';
import {
  ensureKnowledgeIngestedForConversation,
  getKnowledgeRetrievalService,
} from '@/server/knowledge/runtime';
import { resolveMemoryUserIdCandidates } from '@/server/memory/userScope';
import { fuseRecallSources } from '@/server/channels/messages/recallFusion';
import {
  shouldRecallMemoryForInput,
  isExplicitRecallCommand,
  isStrictEvidenceRecallEnabled,
  normalizeMemoryContext,
  detectMemoryFeedbackSignal,
  extractCorrectionContent,
  MEMORY_RECALL_LIMIT,
  MEMORY_FEEDBACK_WINDOW_MS,
  type LastRecallState,
  type KnowledgeRetrievalServiceLike,
} from './types';

const MEM0_EMPTY_SCOPE_TTL_MS = 5 * 60 * 1000;
const RECALL_QUERY_STOP_WORDS = new Set([
  'erinner',
  'erinnere',
  'dich',
  'welche',
  'welcher',
  'welches',
  'welchen',
  'was',
  'wie',
  'wann',
  'wo',
  'warum',
  'wieso',
  'du',
  'ich',
  'mir',
  'mich',
  'dein',
  'deine',
  'heute',
  'gestern',
  'vorgestern',
  'nochmal',
  'machen',
  'machst',
  'willst',
  'wolltest',
  'wollen',
  'will',
  'remember',
  'recall',
  'bitte',
  'denn',
  'mal',
]);
const TIME_TOKENS = new Set(['heute', 'gestern', 'vorgestern', 'abend', 'morgen', 'nacht']);
const COMMITMENT_TOKENS = new Set([
  'will',
  'werde',
  'mache',
  'mach',
  'mochte',
  'möchte',
  'plane',
  'vor',
  'nehme',
]);

type StrictRecallCandidate = {
  source: 'chat' | 'memory';
  role: 'user' | 'agent' | 'system' | 'memory';
  text: string;
  createdAt?: string;
  normalized: string;
  topicHits: number;
  timeHits: number;
  score: number;
};

export class RecallService {
  private lastRecallByConversation = new Map<string, LastRecallState>();
  private emptyMem0ScopeCache = new Map<string, number>();

  constructor(
    private readonly searchMessages?: (
      query: string,
      options: SearchMessagesOptions,
    ) => StoredMessage[] | Promise<StoredMessage[]>,
    private readonly isMemoryEnabledForConversation?: (conversation: Conversation) => boolean,
  ) {}

  private isMemoryEnabled(conversation: Conversation): boolean {
    if (typeof this.isMemoryEnabledForConversation === 'function') {
      return this.isMemoryEnabledForConversation(conversation);
    }
    return conversation.channelType !== ChannelType.AGENT_ROOM;
  }

  private getMem0ScopeKey(personaId: string, userId: string): string {
    return `${personaId}::${userId}`;
  }

  private isMem0ScopeTemporarilyEmpty(personaId: string, userId: string): boolean {
    const key = this.getMem0ScopeKey(personaId, userId);
    const expiresAt = this.emptyMem0ScopeCache.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.emptyMem0ScopeCache.delete(key);
      return false;
    }
    return true;
  }

  private markMem0ScopeTemporarilyEmpty(personaId: string, userId: string): void {
    const key = this.getMem0ScopeKey(personaId, userId);
    this.emptyMem0ScopeCache.set(key, Date.now() + MEM0_EMPTY_SCOPE_TTL_MS);
  }

  private clearMem0ScopeEmptyMarker(personaId: string, userId: string): void {
    const key = this.getMem0ScopeKey(personaId, userId);
    this.emptyMem0ScopeCache.delete(key);
  }

  async buildRecallContext(conversation: Conversation, userInput: string): Promise<string | null> {
    if (!this.isMemoryEnabled(conversation)) {
      this.lastRecallByConversation.delete(conversation.id);
      return null;
    }
    if (!conversation.personaId) {
      this.lastRecallByConversation.delete(conversation.id);
      return null;
    }
    const memoryUserIds = resolveMemoryUserIdCandidates({
      userId: conversation.userId,
      channelType: conversation.channelType,
      externalChatId: conversation.externalChatId || 'default',
    });
    const knowledgeConfig = resolveKnowledgeConfig();
    const knowledgeRetrievalService =
      knowledgeConfig.layerEnabled && knowledgeConfig.retrievalEnabled
        ? (getKnowledgeRetrievalService() as unknown as KnowledgeRetrievalServiceLike)
        : null;

    const shouldRecall = shouldRecallMemoryForInput(userInput);
    if (!shouldRecall) return null;
    const explicitRecallCommand = isExplicitRecallCommand(userInput);

    // ─── Parallel recall from all three sources ─────────────────
    const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      this.recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput, {
        skipPreIngest: explicitRecallCommand,
        includeSemantic: !explicitRecallCommand,
      }),
      this.recallFromMemory(memoryUserIds, conversation, userInput, {
        mode: explicitRecallCommand ? 'lexical' : 'semantic',
      }),
      this.recallFromChat(conversation, userInput),
    ]);

    const knowledgeContext = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null;
    const memoryContext = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const chatHits = chatResult.status === 'fulfilled' ? chatResult.value : [];

    const fused = fuseRecallSources({
      knowledge: knowledgeContext,
      memory: memoryContext,
      chatHits,
    });

    return fused;
  }

  async buildStrictEvidenceReply(
    conversation: Conversation,
    userInput: string,
  ): Promise<{ content: string; metadata: Record<string, unknown> } | null> {
    if (!this.isMemoryEnabled(conversation)) return null;
    if (!conversation.personaId) return null;
    if (!isStrictEvidenceRecallEnabled()) return null;
    if (!isExplicitRecallCommand(userInput)) return null;

    const normalizedQuery = normalizeForMatch(userInput);
    const queryTokens = tokenizeNormalized(normalizedQuery);
    const topicTokens = queryTokens.filter((token) => !RECALL_QUERY_STOP_WORDS.has(token));
    const queryTimeTokens = queryTokens.filter((token) => TIME_TOKENS.has(token));
    const memoryUserIds = resolveMemoryUserIdCandidates({
      userId: conversation.userId,
      channelType: conversation.channelType,
      externalChatId: conversation.externalChatId || 'default',
    });

    const [chatHits, memoryRecalled] = await Promise.all([
      this.recallFromChat(conversation, userInput),
      this.recallFromMemoryDetailed(memoryUserIds, conversation, userInput, { mode: 'lexical' }),
    ]);

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

    for (const match of memoryRecalled.matches || []) {
      const text = String(match?.node?.content || '').trim();
      if (!text) continue;
      const normalized = normalizeForMatch(text);
      const topicHits = countHits(normalized, topicTokens);
      const timeHits = countHits(normalized, queryTimeTokens);
      const commitmentBonus = hasAnyToken(normalized, COMMITMENT_TOKENS) ? 0.4 : 0;
      const timestampValue =
        typeof (match as { node?: { timestamp?: unknown } }).node?.timestamp === 'string'
          ? (match as { node?: { timestamp?: string } }).node?.timestamp
          : undefined;
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

    applyRecencyBoost(candidates);

    const deduped = dedupeCandidates(candidates);
    const relevant = topicTokens.length
      ? deduped.filter((candidate) => candidate.topicHits > 0)
      : deduped;
    const sortedRelevant = [...relevant].sort((a, b) => b.score - a.score);
    const sortedContext = [...deduped]
      .filter((candidate) => candidate.timeHits > 0)
      .sort((a, b) => b.score - a.score);

    if (sortedRelevant.length === 0) {
      const contextLines = sortedContext.slice(0, 3).map((candidate) => `- "${candidate.text}"`);
      const content = contextLines.length
        ? [
            'Ich finde keine belastbare Erinnerung dazu, welche Übung du heute nochmal machen willst.',
            '',
            'Ich finde nur diese Aussagen zum Zeitkontext:',
            ...contextLines,
          ].join('\n')
        : 'Ich finde keine belastbare Erinnerung dazu, welche Übung du heute nochmal machen willst.';
      return {
        content,
        metadata: {
          ok: true,
          runtime: 'strict-recall',
          strictRecall: true,
          confidence: 'low',
          candidateCount: deduped.length,
          relevantCount: 0,
          topicTokens,
        },
      };
    }

    const winner = sortedRelevant[0];
    const runnerUp = sortedRelevant[1];
    const hasConflict = Boolean(runnerUp && Math.abs(winner.score - runnerUp.score) < 0.8);

    const evidenceLines = (
      hasConflict ? sortedRelevant.slice(0, 3) : sortedRelevant.slice(0, 2)
    ).map(
      (candidate, index) =>
        `${index + 1}. [${candidate.source}/${candidate.role}] ${candidate.text}${candidate.createdAt ? ` (${candidate.createdAt})` : ''}`,
    );

    const answer = hasConflict
      ? [
          'Ich finde mehrere gleich plausible Erinnerungen und kann keine eindeutig priorisieren.',
          `Mögliche Aussagen: ${sortedRelevant
            .slice(0, 3)
            .map((candidate) => `"${candidate.text}"`)
            .join(' | ')}`,
        ].join('\n')
      : `Nach den belegbaren Erinnerungen willst du heute nochmal: "${winner.text}"`;

    return {
      content: [answer, '', 'Belege:', ...evidenceLines].join('\n'),
      metadata: {
        ok: true,
        runtime: 'strict-recall',
        strictRecall: true,
        confidence: hasConflict ? 'medium' : 'high',
        conflict: hasConflict,
        candidateCount: deduped.length,
        relevantCount: sortedRelevant.length,
        topicTokens,
      },
    };
  }

  /** Recall from Knowledge Layer (episodes / meeting ledger). */
  private async recallFromKnowledge(
    service: KnowledgeRetrievalServiceLike | null,
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
    options: { skipPreIngest: boolean; includeSemantic: boolean },
  ): Promise<string | null> {
    if (!service) return null;
    for (const userIdCandidate of memoryUserIds) {
      if (!options.skipPreIngest) {
        try {
          await ensureKnowledgeIngestedForConversation({
            conversationId: conversation.id,
            userId: userIdCandidate,
            personaId: conversation.personaId!,
          });
        } catch (error) {
          console.error('Knowledge pre-ingest failed:', error);
        }
      }
      try {
        const result = await service.retrieve({
          userId: userIdCandidate,
          personaId: conversation.personaId!,
          conversationId: conversation.id,
          query: userInput,
          includeSemantic: options.includeSemantic,
        });
        const normalized = normalizeMemoryContext(result.context || '');
        if (normalized) return normalized;
      } catch (error) {
        console.error('Knowledge recall failed:', error);
      }
    }
    return null;
  }

  /** Recall from Mem0 semantic memory. */
  private async recallFromMemory(
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
    options: { mode: 'semantic' | 'lexical' },
  ): Promise<string | null> {
    const personaId = conversation.personaId!;
    for (const userIdCandidate of memoryUserIds) {
      if (this.isMem0ScopeTemporarilyEmpty(personaId, userIdCandidate)) {
        continue;
      }
      try {
        const recalled = await getMemoryService().recallDetailed(
          personaId,
          userInput,
          MEMORY_RECALL_LIMIT,
          userIdCandidate,
          { mode: options.mode },
        );
        if (recalled.matches.length > 0) {
          this.clearMem0ScopeEmptyMarker(personaId, userIdCandidate);
          this.lastRecallByConversation.set(conversation.id, {
            personaId,
            userId: userIdCandidate,
            nodeIds: recalled.matches.map((entry) => entry.node.id),
            queriedAt: Date.now(),
          });
        }
        const normalized = normalizeMemoryContext(recalled.context);
        if (normalized) {
          this.clearMem0ScopeEmptyMarker(personaId, userIdCandidate);
          return normalized;
        }
        if (recalled.matches.length === 0) {
          this.markMem0ScopeTemporarilyEmpty(personaId, userIdCandidate);
        }
      } catch (error) {
        console.error('Memory recall failed:', error);
      }
    }
    return null;
  }

  private async recallFromMemoryDetailed(
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

  /** Recall from FTS5 full-text search on chat messages (persona-scoped). */
  async recallFromChat(
    conversation: Conversation,
    userInput: string,
    searchMessagesOverride?: (
      query: string,
      options: SearchMessagesOptions,
    ) => StoredMessage[] | Promise<StoredMessage[]>,
  ): Promise<StoredMessage[]> {
    const searchMessages = searchMessagesOverride || this.searchMessages;
    if (!searchMessages) return [];
    try {
      const inputNorm = userInput
        .trim()
        .toLowerCase()
        .replace(/[?.!]+$/, '');
      // Overfetch generously to survive duplicate flooding from repeated queries
      const maybeRaw = await searchMessages(userInput, {
        userId: conversation.userId,
        personaId: conversation.personaId ?? undefined,
        limit: 50,
      } as SearchMessagesOptions);
      const raw = Array.isArray(maybeRaw) ? maybeRaw : [];

      const filtered = raw.filter((m) => {
        // Exclude messages that are (near-)exact duplicates of the current query
        const content = m.content
          .trim()
          .toLowerCase()
          .replace(/[?.!]+$/, '');
        return content !== inputNorm;
      });

      // Deduplicate near-identical agent responses (e.g. repeated "Ja, die Regeln sind...")
      const seen = new Set<string>();
      const deduped = filtered.filter((m) => {
        // For agent messages, use first 80 chars as fingerprint to collapse repetitions
        if (m.role !== 'user') {
          const fingerprint = m.content.substring(0, 80).toLowerCase();
          if (seen.has(fingerprint)) return false;
          seen.add(fingerprint);
        }
        return true;
      });

      // Prioritize user messages (explicit instructions) over agent paraphrases
      const userMsgs = deduped.filter((m) => m.role === 'user');
      const agentMsgs = deduped.filter((m) => m.role !== 'user');
      return [...userMsgs, ...agentMsgs].slice(0, 10);
    } catch (error) {
      console.error('Chat FTS5 recall failed:', error);
      return [];
    }
  }

  async maybeLearnFromFeedback(conversation: Conversation, userInput: string): Promise<void> {
    if (!this.isMemoryEnabled(conversation)) {
      this.lastRecallByConversation.delete(conversation.id);
      return;
    }
    if (!conversation.personaId) return;

    const feedback = detectMemoryFeedbackSignal(userInput);
    if (!feedback) return;

    const state = this.lastRecallByConversation.get(conversation.id);
    if (!state) return;
    if (state.personaId !== conversation.personaId) return;
    if (Date.now() - state.queriedAt > MEMORY_FEEDBACK_WINDOW_MS) {
      this.lastRecallByConversation.delete(conversation.id);
      return;
    }

    try {
      await getMemoryService().registerFeedback(
        conversation.personaId,
        state.nodeIds,
        feedback,
        state.userId,
      );

      if (feedback === 'negative') {
        const correction = extractCorrectionContent(userInput);
        if (correction) {
          await getMemoryService().store(
            conversation.personaId,
            'fact',
            correction,
            5,
            state.userId,
            {
              subject: 'user',
              sourceRole: 'user',
              sourceType: 'feedback_correction',
            },
          );
        }
      }
    } catch (error) {
      console.error('Memory feedback learning failed:', error);
    } finally {
      this.lastRecallByConversation.delete(conversation.id);
    }
  }

  clearConversationState(conversationId: string): void {
    this.lastRecallByConversation.delete(conversationId);
  }
}

function normalizeForMatch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeNormalized(value: string): string[] {
  return (
    value
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => token.trim())
      .filter(Boolean) || []
  );
}

function countHits(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (token && text.includes(token)) hits += 1;
  }
  return hits;
}

function hasAnyToken(text: string, tokens: Set<string>): boolean {
  for (const token of tokens) {
    if (text.includes(token)) return true;
  }
  return false;
}

function applyRecencyBoost(candidates: StrictRecallCandidate[]): void {
  const timestamps = candidates
    .map((candidate) => (candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return;
  const newest = Math.max(...timestamps);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const candidate of candidates) {
    if (!candidate.createdAt) continue;
    const ts = Date.parse(candidate.createdAt);
    if (!Number.isFinite(ts)) continue;
    const dayDistance = Math.max(0, (newest - ts) / dayMs);
    const boost = Math.max(0, 0.7 - dayDistance * 0.1);
    candidate.score += boost;
  }
}

function dedupeCandidates(candidates: StrictRecallCandidate[]): StrictRecallCandidate[] {
  const map = new Map<string, StrictRecallCandidate>();
  for (const candidate of candidates) {
    const key = candidate.normalized;
    const existing = map.get(key);
    if (!existing || candidate.score > existing.score) {
      map.set(key, candidate);
    }
  }
  return [...map.values()];
}
