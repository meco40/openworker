/**
 * Recall Service - Message recall and memory operations
 *
 * Modularized structure:
 * - types.ts: Type definitions
 * - constants.ts: Constants
 * - utils.ts: Utility functions
 * - search/: Search operations (messages, knowledge, strict)
 * - evidence/: Evidence handling (build, format)
 * - learning/: Feedback learning
 * - state/: State management
 */

import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { SearchMessagesOptions } from '@/server/channels/messages/repository/types';
import { ChannelType } from '@/shared/domain/types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveKnowledgeConfig } from '@/server/knowledge/config';
import { getKnowledgeRetrievalService } from '@/server/knowledge/runtime';
import { resolveMemoryUserIdCandidates } from '@/server/memory/userScope';
import { fuseRecallSources } from '@/server/channels/messages/recallFusion';
import {
  getChatRecallSlowThresholdMs,
  logChatRecallTrace,
  previewRecallText,
} from '@/server/diagnostics/chatRecallTrace';
import { summarizeError } from '@/server/diagnostics/errorSummary';
import {
  shouldRecallMemoryForInput,
  isExplicitRecallCommand,
  normalizeMemoryContext,
  MEMORY_RECALL_LIMIT,
  MEMORY_FEEDBACK_WINDOW_MS,
} from '../types';
import { recallFromKnowledge, recallFromChat } from './search';
import { buildStrictEvidenceReply } from './evidence';
import { learnFromFeedback } from './learning';
import { RecallStateManager } from './state';
import { isMem0PreferencesOnly } from '@/server/world-model/mem0Policy';
import { formatWorldModelContext, retrieveContext } from '@/server/world-model/retrieval';
import type { MemoryType } from '@/core/memory/types';

// Re-export types for backward compatibility
export type { StrictRecallCandidate } from './types';
export { MEM0_EMPTY_SCOPE_TTL_MS } from './constants';

/**
 * Service for recalling messages and memories from various sources
 */
export class RecallService {
  private stateManager = new RecallStateManager();

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

  /**
   * Build recall context from all available sources (knowledge, memory, chat)
   */
  async buildRecallContext(conversation: Conversation, userInput: string): Promise<string | null> {
    if (!this.isMemoryEnabled(conversation)) {
      this.stateManager.deleteState(conversation.id);
      return null;
    }
    if (!conversation.personaId) {
      this.stateManager.deleteState(conversation.id);
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
        ? getKnowledgeRetrievalService()
        : null;

    const shouldRecall = shouldRecallMemoryForInput(userInput);
    if (!shouldRecall) return null;
    const explicitRecallCommand = isExplicitRecallCommand(userInput);
    const startedAt = Date.now();
    const sourceDurationsMs: Partial<
      Record<'worldModel' | 'knowledge' | 'memory' | 'chat', number>
    > = {};
    const measure = async <T>(
      source: 'worldModel' | 'knowledge' | 'memory' | 'chat',
      fn: () => Promise<T>,
    ): Promise<T> => {
      const sourceStartedAt = Date.now();
      try {
        return await fn();
      } finally {
        sourceDurationsMs[source] = Date.now() - sourceStartedAt;
      }
    };

    const preferencesOnly = isMem0PreferencesOnly();
    const preferenceMemoryTypes: MemoryType[] = [
      'preference',
      'avoidance',
      'personality_trait',
      'workflow_pattern',
    ];

    // Parallel recall from canonical world model and compatible projections.
    const [worldModelResult, knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      measure('worldModel', async () => {
        for (const userIdCandidate of memoryUserIds) {
          const result = await retrieveContext({
            userId: userIdCandidate,
            personaId: conversation.personaId!,
            workspaceId: '',
            query: userInput,
          });
          const context = formatWorldModelContext(result);
          if (context) return context;
        }
        return null;
      }),
      measure('knowledge', () =>
        recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput, {
          skipPreIngest: explicitRecallCommand,
          includeSemantic: !explicitRecallCommand && !preferencesOnly,
        }),
      ),
      measure('memory', () =>
        this.recallFromMemory(memoryUserIds, conversation, userInput, {
          mode: explicitRecallCommand ? 'lexical' : 'semantic',
          memoryTypes: preferencesOnly ? preferenceMemoryTypes : undefined,
        }),
      ),
      measure('chat', () => this.recallFromChat(conversation, userInput)),
    ]);

    const worldModelContext =
      worldModelResult.status === 'fulfilled' ? worldModelResult.value : null;
    const knowledgeContext = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null;
    const memoryContext = memoryResult.status === 'fulfilled' ? memoryResult.value : null;
    const chatHits = chatResult.status === 'fulfilled' ? chatResult.value : [];

    const fused = fuseRecallSources({
      worldModel: worldModelContext,
      knowledge: knowledgeContext,
      memory: memoryContext,
      chatHits,
    });

    const durationMs = Date.now() - startedAt;
    const slowThresholdMs = getChatRecallSlowThresholdMs();
    const slow = durationMs >= slowThresholdMs;
    const hasFailure =
      knowledgeResult.status === 'rejected' ||
      memoryResult.status === 'rejected' ||
      chatResult.status === 'rejected' ||
      worldModelResult.status === 'rejected';
    logChatRecallTrace(
      'context.completed',
      {
        durationMs,
        slow,
        slowThresholdMs,
        conversationId: conversation.id,
        channelType: conversation.channelType,
        externalChatId: conversation.externalChatId || null,
        personaId: conversation.personaId ?? null,
        userId: conversation.userId,
        queryLength: userInput.trim().length,
        queryPreview: previewRecallText(userInput),
        explicitRecallCommand,
        memoryUserIdsCount: memoryUserIds.length,
        sourceDurationsMs,
        sourceStatuses: {
          worldModel: worldModelResult.status,
          knowledge: knowledgeResult.status,
          memory: memoryResult.status,
          chat: chatResult.status,
        },
        hasKnowledgeContext: Boolean(knowledgeContext),
        hasWorldModelContext: Boolean(worldModelContext),
        hasMemoryContext: Boolean(memoryContext),
        chatHitCount: chatHits.length,
        fusedLength: fused?.length ?? 0,
      },
      { force: slow || hasFailure, level: hasFailure ? 'warn' : 'info' },
    );

    return fused;
  }

  /**
   * Build strict evidence reply with verifiable sources
   */
  async buildStrictEvidenceReply(
    conversation: Conversation,
    userInput: string,
  ): Promise<{ content: string; metadata: Record<string, unknown> } | null> {
    const isMemoryEnabled = this.isMemoryEnabled(conversation);
    const chatHits = await this.recallFromChat(conversation, userInput);
    return buildStrictEvidenceReply(conversation, userInput, isMemoryEnabled, chatHits);
  }

  /**
   * Recall from Mem0 semantic memory
   */
  private logMemoryScopeCompleted(
    conversation: Conversation,
    personaId: string,
    memoryUserId: string,
    userInput: string,
    mode: 'semantic' | 'lexical',
    durationMs: number,
    matchesCount: number,
    contextLength: number,
    emptyScopeMarked: boolean,
  ): void {
    const slowThresholdMs = getChatRecallSlowThresholdMs();
    logChatRecallTrace(
      'memory.scope_completed',
      {
        durationMs,
        slow: durationMs >= slowThresholdMs,
        slowThresholdMs,
        conversationId: conversation.id,
        channelType: conversation.channelType,
        externalChatId: conversation.externalChatId || null,
        personaId,
        memoryUserId,
        queryLength: userInput.trim().length,
        queryPreview: previewRecallText(userInput),
        mode,
        matchesCount,
        contextLength,
        ...(emptyScopeMarked ? { emptyScopeMarked: true } : {}),
      },
      { force: durationMs >= slowThresholdMs },
    );
  }

  private async recallFromMemory(
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
    options: { mode: 'semantic' | 'lexical'; memoryTypes?: MemoryType[] },
  ): Promise<string | null> {
    const personaId = conversation.personaId!;
    for (const userIdCandidate of memoryUserIds) {
      if (this.stateManager.isMem0ScopeTemporarilyEmpty(personaId, userIdCandidate)) {
        continue;
      }
      const startedAt = Date.now();
      try {
        const recalled = await getMemoryService().recallDetailed(
          personaId,
          userInput,
          MEMORY_RECALL_LIMIT,
          userIdCandidate,
          { mode: options.mode, memoryTypes: options.memoryTypes },
        );
        if (recalled.matches.length > 0) {
          this.stateManager.clearMem0ScopeEmptyMarker(personaId, userIdCandidate);
          this.stateManager.setState(conversation.id, {
            personaId,
            userId: userIdCandidate,
            nodeIds: recalled.matches.map((entry) => entry.node.id),
            queriedAt: Date.now(),
          });
        }
        const normalized = normalizeMemoryContext(recalled.context);
        if (normalized) {
          this.stateManager.clearMem0ScopeEmptyMarker(personaId, userIdCandidate);
        }
        if (recalled.matches.length === 0) {
          this.stateManager.markMem0ScopeTemporarilyEmpty(personaId, userIdCandidate);
        }
        const durationMs = Date.now() - startedAt;
        this.logMemoryScopeCompleted(
          conversation,
          personaId,
          userIdCandidate,
          userInput,
          options.mode,
          durationMs,
          recalled.matches.length,
          normalized?.length ?? 0,
          recalled.matches.length === 0,
        );
        if (normalized) return normalized;
      } catch (error) {
        logChatRecallTrace(
          'memory.scope_failed',
          {
            durationMs: Date.now() - startedAt,
            conversationId: conversation.id,
            channelType: conversation.channelType,
            externalChatId: conversation.externalChatId || null,
            personaId,
            memoryUserId: userIdCandidate,
            queryLength: userInput.trim().length,
            queryPreview: previewRecallText(userInput),
            mode: options.mode,
            error: summarizeError(error),
          },
          { force: true, level: 'error' },
        );
        console.error('Memory recall failed:', summarizeError(error));
      }
    }
    return null;
  }

  /**
   * Recall from chat history using FTS5
   */
  async recallFromChat(
    conversation: Conversation,
    userInput: string,
    searchMessagesOverride?: (
      query: string,
      options: SearchMessagesOptions,
    ) => StoredMessage[] | Promise<StoredMessage[]>,
  ): Promise<StoredMessage[]> {
    const searchMessages = searchMessagesOverride || this.searchMessages;
    return recallFromChat(conversation, userInput, searchMessages);
  }

  /**
   * Learn from user feedback about memory recall
   */
  async maybeLearnFromFeedback(conversation: Conversation, userInput: string): Promise<void> {
    if (!this.isMemoryEnabled(conversation)) {
      this.stateManager.deleteState(conversation.id);
      return;
    }

    const lastRecallState = this.stateManager.getState(conversation.id);

    // Check if feedback is stale
    if (lastRecallState && Date.now() - lastRecallState.queriedAt > MEMORY_FEEDBACK_WINDOW_MS) {
      this.stateManager.deleteState(conversation.id);
      return;
    }

    await learnFromFeedback(conversation, userInput, lastRecallState);
    this.stateManager.deleteState(conversation.id);
  }

  /**
   * Clear conversation state
   */
  clearConversationState(conversationId: string): void {
    this.stateManager.deleteState(conversationId);
  }
}

// Re-export utility functions for backward compatibility
export {
  normalizeForMatch,
  tokenizeNormalized,
  countHits,
  hasAnyToken,
  applyRecencyBoost,
  dedupeCandidates,
} from './utils';

// Re-export constants for backward compatibility
export { RECALL_QUERY_STOP_WORDS, TIME_TOKENS, COMMITMENT_TOKENS } from './constants';
