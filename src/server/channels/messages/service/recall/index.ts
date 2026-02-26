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
import type { SearchMessagesOptions } from '@/server/channels/messages/sqliteMessageRepository';
import { ChannelType } from '@/shared/domain/types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveKnowledgeConfig } from '@/server/knowledge/config';
import { getKnowledgeRetrievalService } from '@/server/knowledge/runtime';
import { resolveMemoryUserIdCandidates } from '@/server/memory/userScope';
import { fuseRecallSources } from '@/server/channels/messages/recallFusion';
import {
  shouldRecallMemoryForInput,
  isExplicitRecallCommand,
  normalizeMemoryContext,
  MEMORY_RECALL_LIMIT,
  MEMORY_FEEDBACK_WINDOW_MS,
  type KnowledgeRetrievalServiceLike,
} from '../types';
import { recallFromKnowledge, recallFromChat } from './search';
import { buildStrictEvidenceReply } from './evidence';
import { learnFromFeedback } from './learning';
import { RecallStateManager } from './state';

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
        ? (getKnowledgeRetrievalService() as unknown as KnowledgeRetrievalServiceLike)
        : null;

    const shouldRecall = shouldRecallMemoryForInput(userInput);
    if (!shouldRecall) return null;
    const explicitRecallCommand = isExplicitRecallCommand(userInput);

    // Parallel recall from all three sources
    const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
      recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput, {
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
  private async recallFromMemory(
    memoryUserIds: string[],
    conversation: Conversation,
    userInput: string,
    options: { mode: 'semantic' | 'lexical' },
  ): Promise<string | null> {
    const personaId = conversation.personaId!;
    for (const userIdCandidate of memoryUserIds) {
      if (this.stateManager.isMem0ScopeTemporarilyEmpty(personaId, userIdCandidate)) {
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
          return normalized;
        }
        if (recalled.matches.length === 0) {
          this.stateManager.markMem0ScopeTemporarilyEmpty(personaId, userIdCandidate);
        }
      } catch (error) {
        console.error('Memory recall failed:', error);
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

// Default export
export default RecallService;
