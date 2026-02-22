import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { getModelHubService, getModelHubEncryptionKey } from '@/server/model-hub/runtime';
import { buildFallbackSummary, isAiSummaryEnabled } from '@/server/channels/messages/summary';
import { resolveMemoryScopedUserId } from '@/server/memory/userScope';
import { getMemoryService } from '@/server/memory/runtime';
import {
  isAutoSessionMemoryEnabled,
  buildAutoMemoryCandidates,
} from '@/server/channels/messages/autoMemory';
import { getServerEventBus } from '@/server/events/runtime';

export class SummaryService {
  private summaryRefreshInFlight = new Set<string>();

  constructor(
    private readonly repo: {
      listMessages: (
        conversationId: string,
        limit?: number,
        before?: string,
        userId?: string,
      ) => StoredMessage[];
      getConversationContext: (
        conversationId: string,
        userId: string,
      ) => { summaryText?: string; summaryUptoSeq?: number } | null;
      upsertConversationContext: (
        conversationId: string,
        summaryText: string,
        uptoSeq: number,
        userId: string,
      ) => void;
    },
  ) {}

  isInFlight(conversationId: string): boolean {
    return this.summaryRefreshInFlight.has(conversationId);
  }

  clearInFlight(conversationId: string): void {
    this.summaryRefreshInFlight.delete(conversationId);
  }

  async maybeRefreshConversationSummary(conversation: Conversation): Promise<void> {
    if (this.summaryRefreshInFlight.has(conversation.id)) {
      return;
    }

    this.summaryRefreshInFlight.add(conversation.id);
    try {
      const recent = this.repo.listMessages(conversation.id, 200, undefined, conversation.userId);
      if (recent.length === 0) {
        return;
      }

      const existing = this.repo.getConversationContext(conversation.id, conversation.userId);
      const summaryUptoSeq = existing?.summaryUptoSeq ?? 0;
      const lastSeq = recent[recent.length - 1]?.seq ?? 0;

      if (lastSeq - summaryUptoSeq < 20) {
        return;
      }

      const unsummarized = recent.filter(
        (message) => typeof message.seq === 'number' && message.seq > summaryUptoSeq,
      );
      if (unsummarized.length === 0) {
        return;
      }
      const summarizationChunk = unsummarized.slice(0, 40);

      const mergedSummary = await this.buildConversationSummary(
        existing?.summaryText || '',
        summarizationChunk.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        conversation.id,
      );

      if (!mergedSummary) {
        return;
      }

      const uptoSeq = summarizationChunk[summarizationChunk.length - 1]?.seq;
      if (typeof uptoSeq !== 'number') {
        return;
      }

      this.repo.upsertConversationContext(
        conversation.id,
        mergedSummary,
        uptoSeq,
        conversation.userId,
      );

      getServerEventBus().publish('chat.summary.refreshed', {
        conversationId: conversation.id,
        userId: conversation.userId,
        personaId: conversation.personaId,
        summaryText: mergedSummary,
        summaryUptoSeq: uptoSeq,
        messages: summarizationChunk,
        createdAt: new Date().toISOString(),
      });

      await this.maybeStoreAutoSessionMemory(conversation, summarizationChunk);
      await this.maybeStoreKnowledgeArtifacts(conversation, summarizationChunk, mergedSummary);
    } finally {
      this.summaryRefreshInFlight.delete(conversation.id);
    }
  }

  private async maybeStoreAutoSessionMemory(
    conversation: Conversation,
    messages: StoredMessage[],
  ): Promise<void> {
    if (!conversation.personaId) return;
    if (!isAutoSessionMemoryEnabled()) return;

    const candidates = buildAutoMemoryCandidates(messages);
    if (candidates.length === 0) return;
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: conversation.channelType,
      externalChatId: conversation.externalChatId || 'default',
    });

    for (const candidate of candidates) {
      try {
        await getMemoryService().store(
          conversation.personaId,
          candidate.type,
          candidate.content,
          candidate.importance,
          memoryUserId,
          {
            subject: 'user',
            sourceRole: 'user',
            sourceType: 'auto_session',
          },
        );
      } catch (error) {
        console.error('Auto session memory store failed:', error);
      }
    }
  }

  private async maybeStoreKnowledgeArtifacts(
    conversation: Conversation,
    messages: StoredMessage[],
    mergedSummary: string,
  ): Promise<void> {
    if (!conversation.personaId) return;
    if (messages.length === 0) return;

    const { resolveKnowledgeConfig } = await import('@/server/knowledge/config');
    const knowledgeConfig = resolveKnowledgeConfig();
    if (!knowledgeConfig.layerEnabled) return;
    if (!knowledgeConfig.episodeEnabled && !knowledgeConfig.ledgerEnabled) return;

    try {
      const { getKnowledgeIngestionService } = await import('@/server/knowledge/runtime');
      await getKnowledgeIngestionService().ingestConversationWindow({
        conversationId: conversation.id,
        userId: resolveMemoryScopedUserId({
          userId: conversation.userId,
          channelType: conversation.channelType,
          externalChatId: conversation.externalChatId || 'default',
        }),
        personaId: conversation.personaId,
        messages,
        summaryText: mergedSummary,
      });
    } catch (error) {
      console.error('Knowledge ingestion failed:', error);
    }
  }

  private async buildConversationSummary(
    previousSummary: string,
    messages: Array<{ role: 'user' | 'agent' | 'system'; content: string }>,
    conversationId: string,
  ): Promise<string> {
    const fallbackSummary = buildFallbackSummary(previousSummary, messages);

    if (!isAiSummaryEnabled()) {
      return fallbackSummary;
    }

    try {
      const service = getModelHubService();
      const encryptionKey = getModelHubEncryptionKey();
      const summaryMessages = [
        {
          role: 'system' as const,
          content:
            'You summarize a conversation for long-term continuity. Return concise plain text summary only.',
        },
        {
          role: 'user' as const,
          content: [
            'Previous summary:',
            previousSummary || '(none)',
            '',
            'New messages:',
            ...messages.map((message) => `[${message.role}] ${message.content}`),
            '',
            'Task: Write an updated conversation summary in <= 400 words.',
          ].join('\n'),
        },
      ];

      const result = await service.dispatchWithFallback('p1', encryptionKey, {
        messages: summaryMessages,
        auditContext: {
          kind: 'summary',
          conversationId,
        },
      });

      if (result.ok && result.text?.trim()) {
        return result.text.trim().slice(-5000);
      }

      return fallbackSummary;
    } catch {
      return fallbackSummary;
    }
  }
}
