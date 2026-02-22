import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SearchMessagesOptions } from '@/server/channels/messages/sqliteMessageRepository';
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
  normalizeMemoryContext,
  detectMemoryFeedbackSignal,
  extractCorrectionContent,
  MEMORY_RECALL_LIMIT,
  MEMORY_FEEDBACK_WINDOW_MS,
  type LastRecallState,
  type KnowledgeRetrievalServiceLike,
} from './types';

const MEM0_EMPTY_SCOPE_TTL_MS = 5 * 60 * 1000;

export class RecallService {
  private lastRecallByConversation = new Map<string, LastRecallState>();
  private emptyMem0ScopeCache = new Map<string, number>();

  constructor() {}

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

    // ─── Parallel recall from all three sources ─────────────────
    const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      this.recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput),
      this.recallFromMemory(memoryUserIds, conversation, userInput),
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

  /** Recall from Knowledge Layer (episodes / meeting ledger). */
  private async recallFromKnowledge(
    service: KnowledgeRetrievalServiceLike | null,
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
  ): Promise<string | null> {
    if (!service) return null;
    for (const userIdCandidate of memoryUserIds) {
      try {
        await ensureKnowledgeIngestedForConversation({
          conversationId: conversation.id,
          userId: userIdCandidate,
          personaId: conversation.personaId!,
        });
      } catch (error) {
        console.error('Knowledge pre-ingest failed:', error);
      }
      try {
        const result = await service.retrieve({
          userId: userIdCandidate,
          personaId: conversation.personaId!,
          conversationId: conversation.id,
          query: userInput,
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

  /** Recall from FTS5 full-text search on chat messages (persona-scoped). */
  recallFromChat(
    conversation: Conversation,
    userInput: string,
    searchMessages?: (query: string, options: SearchMessagesOptions) => StoredMessage[],
  ): StoredMessage[] {
    if (!searchMessages) return [];
    try {
      const inputNorm = userInput
        .trim()
        .toLowerCase()
        .replace(/[?.!]+$/, '');
      // Overfetch generously to survive duplicate flooding from repeated queries
      const raw = searchMessages(userInput, {
        userId: conversation.userId,
        personaId: conversation.personaId ?? undefined,
        limit: 50,
      } as SearchMessagesOptions);

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
