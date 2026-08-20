import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { ChannelType } from '@/shared/domain/types';
import { getModelHubService, getModelHubEncryptionKey } from '@/server/model-hub/runtime';
import { buildFallbackSummary, isAiSummaryEnabled } from '@/server/channels/messages/summary';
import { resolveMemoryScopedUserId } from '@/server/memory/userScope';
import { getMemoryService } from '@/server/memory/runtime';
import {
  isAutoSessionMemoryEnabled,
  buildAutoMemoryCandidates,
  getAutoSessionMemoryMode,
} from '@/server/channels/messages/autoMemory';
import {
  getAutoSessionMemorySlowThresholdMs,
  logAutoSessionMemoryTrace,
} from '@/server/diagnostics/autoSessionMemoryTrace';
import { getServerEventBus } from '@/server/events/runtime';
import { isInlineKnowledgeIngestionEnabled } from '@/server/knowledge/inlineIngestionPolicy';

export class SummaryService {
  private summaryRefreshInFlight = new Set<string>();
  private static readonly AUTO_SESSION_MEMORY_TIMEOUT_MS = 3000;

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
      isAgentRoomConversation?: (conversationId: string, userId?: string) => boolean;
    },
  ) {}

  private isAgentRoomConversation(conversation: Conversation): boolean {
    if (conversation.channelType === ChannelType.AGENT_ROOM) return true;
    if (typeof this.repo.isAgentRoomConversation === 'function') {
      return this.repo.isAgentRoomConversation(conversation.id, conversation.userId);
    }
    return false;
  }

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

      // Release the in-flight lock NOW — SQLite write is done, the rest is
      // background I/O (Mem0 / knowledge ingestion) that must NOT block the
      // summary cycle or any subsequent message from triggering a new refresh.
      this.summaryRefreshInFlight.delete(conversation.id);

      // Fire-and-forget — these are best-effort side effects.
      void this.maybeStoreAutoSessionMemory(conversation, summarizationChunk);
      void this.maybeStoreKnowledgeArtifacts(conversation, summarizationChunk, mergedSummary);
      return;
    } finally {
      // Idempotent safety net for early-return / exception paths.
      this.summaryRefreshInFlight.delete(conversation.id);
    }
  }

  private async maybeStoreAutoSessionMemory(
    conversation: Conversation,
    messages: StoredMessage[],
  ): Promise<void> {
    const mode = getAutoSessionMemoryMode();
    if (this.isAgentRoomConversation(conversation)) {
      logAutoSessionMemoryTrace('summary.skip', {
        conversationId: conversation.id,
        personaId: conversation.personaId,
        reason: 'agent_room',
        mode,
      });
      return;
    }
    if (!conversation.personaId) {
      logAutoSessionMemoryTrace('summary.skip', {
        conversationId: conversation.id,
        personaId: conversation.personaId,
        reason: 'missing_persona',
        mode,
      });
      return;
    }
    if (!isAutoSessionMemoryEnabled()) {
      logAutoSessionMemoryTrace('summary.skip', {
        conversationId: conversation.id,
        personaId: conversation.personaId,
        reason: 'disabled',
        mode,
      });
      return;
    }

    const candidates = buildAutoMemoryCandidates(messages);
    if (candidates.length === 0) {
      logAutoSessionMemoryTrace('summary.skip', {
        conversationId: conversation.id,
        personaId: conversation.personaId,
        reason: 'no_candidates',
        mode,
      });
      return;
    }
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: conversation.channelType,
      externalChatId: conversation.externalChatId || 'default',
    });
    const batchStartedAt = Date.now();
    const slowThresholdMs = getAutoSessionMemorySlowThresholdMs();
    let storedCount = 0;
    let failedCount = 0;

    logAutoSessionMemoryTrace('summary.batch.start', {
      conversationId: conversation.id,
      personaId: conversation.personaId,
      memoryUserId,
      candidateCount: candidates.length,
      messageCount: messages.length,
      mode,
      timeoutMs: SummaryService.AUTO_SESSION_MEMORY_TIMEOUT_MS,
    });

    let circuitOpen = false;
    for (const [index, candidate] of candidates.entries()) {
      if (circuitOpen) break;
      const startedAt = Date.now();
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const memoryService = getMemoryService();
        const metadata = {
          subject: 'user',
          sourceRole: 'user',
          sourceType: 'auto_session',
          idempotencyKey: `auto-session:${conversation.id}:${candidate.content}`,
        };
        const storePromise =
          typeof memoryService.storeMemory === 'function'
            ? memoryService.storeMemory({
                personaId: conversation.personaId,
                type: candidate.type,
                content: candidate.content,
                importance: candidate.importance,
                userId: memoryUserId,
                metadata,
                signal: controller.signal,
              })
            : memoryService.store(
                conversation.personaId,
                candidate.type,
                candidate.content,
                candidate.importance,
                memoryUserId,
                metadata,
                controller.signal,
              );
        storePromise.catch(() => {});
        await Promise.race([
          storePromise,
          new Promise<never>(
            (_resolve, reject) =>
              (timeoutHandle = setTimeout(() => {
                controller.abort();
                reject(
                  new Error(
                    `auto-session memory candidate timeout after ${SummaryService.AUTO_SESSION_MEMORY_TIMEOUT_MS}ms`,
                  ),
                );
              }, SummaryService.AUTO_SESSION_MEMORY_TIMEOUT_MS)),
          ),
        ]);
        storedCount += 1;
        const durationMs = Date.now() - startedAt;
        logAutoSessionMemoryTrace(
          'summary.candidate.stored',
          {
            conversationId: conversation.id,
            personaId: conversation.personaId,
            memoryUserId,
            candidateIndex: index + 1,
            candidateCount: candidates.length,
            candidateType: candidate.type,
            importance: candidate.importance,
            durationMs,
          },
          { force: durationMs >= slowThresholdMs },
        );
      } catch (error) {
        failedCount += 1;
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = message.includes('timeout');
        logAutoSessionMemoryTrace(
          'summary.candidate.failed',
          {
            conversationId: conversation.id,
            personaId: conversation.personaId,
            memoryUserId,
            candidateIndex: index + 1,
            candidateCount: candidates.length,
            candidateType: candidate.type,
            importance: candidate.importance,
            durationMs,
            timeoutMs: SummaryService.AUTO_SESSION_MEMORY_TIMEOUT_MS,
            error: message,
          },
          { force: true, level: timedOut ? 'warn' : 'error' },
        );
        if (timedOut) {
          circuitOpen = true;
          logAutoSessionMemoryTrace(
            'summary.circuit_open',
            {
              conversationId: conversation.id,
              personaId: conversation.personaId,
              memoryUserId,
              candidateIndex: index + 1,
              candidateCount: candidates.length,
              reason: 'timeout',
            },
            { force: true, level: 'warn' },
          );
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }

    const durationMs = Date.now() - batchStartedAt;
    logAutoSessionMemoryTrace(
      'summary.batch.complete',
      {
        conversationId: conversation.id,
        personaId: conversation.personaId,
        memoryUserId,
        candidateCount: candidates.length,
        storedCount,
        failedCount,
        circuitOpen,
        durationMs,
      },
      { force: circuitOpen || durationMs >= slowThresholdMs },
    );
  }

  private async maybeStoreKnowledgeArtifacts(
    conversation: Conversation,
    messages: StoredMessage[],
    mergedSummary: string,
  ): Promise<void> {
    if (this.isAgentRoomConversation(conversation)) return;
    if (!conversation.personaId) return;
    if (messages.length === 0) return;
    if (!isInlineKnowledgeIngestionEnabled()) return;

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
