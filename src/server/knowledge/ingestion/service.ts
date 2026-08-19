import type { IngestionWindow, KnowledgeIngestionCursor } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeExtractor } from '@/server/knowledge/extractor';
import type { ExtractionPersonaContext } from '@/server/knowledge/prompts';
import {
  type IngestConversationWindowInput,
  type KnowledgeIngestionError,
  type KnowledgeIngestionRunResult,
  type KnowledgeIngestionServiceDependencies,
  type KnowledgeIngestionServiceOptions,
} from './types';
import { processWindow as processIngestionWindow } from './messageProcessor';
import { MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE, MEM0_FAILURE_BACKOFF_BASE_MS } from './constants';
import { getWorldModelConfig } from '@/server/world-model/config';
import { upsertWorldModelIngestionCheckpoint } from '@/server/world-model/repositories/ingestionCheckpointRepository';

export class KnowledgeIngestionService {
  private readonly minMessagesPerBatch: number;

  constructor(
    private readonly deps: KnowledgeIngestionServiceDependencies,
    options: KnowledgeIngestionServiceOptions = {},
  ) {
    const configured = Math.floor(Number(options.minMessagesPerBatch || 1));
    this.minMessagesPerBatch = Number.isFinite(configured) ? Math.max(1, configured) : 1;
  }

  private getCheckpoint(conversationId: string, userId: string, personaId: string) {
    const getter = this.deps.knowledgeRepository.getIngestionCheckpoint;
    if (!getter) return null;
    return getter.length >= 3
      ? getter.call(this.deps.knowledgeRepository, conversationId, userId, personaId)
      : getter.call(this.deps.knowledgeRepository, conversationId, personaId);
  }

  async ingestConversationWindow(input: IngestConversationWindowInput): Promise<void> {
    const personaId = String(input.personaId || '').trim();
    if (!personaId) return;

    const sortedMessages = [...(input.messages || [])]
      .filter((message) => Number.isFinite(Number(message.seq)))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    if (sortedMessages.length === 0) return;

    const checkpoint = this.getCheckpoint(input.conversationId, input.userId, personaId);
    const fromSeqExclusive = Math.max(0, Math.floor(Number(checkpoint?.lastSeq || 0)));
    const deltaMessages = sortedMessages.filter(
      (message) => Math.floor(Number(message.seq || 0)) > fromSeqExclusive,
    );
    if (deltaMessages.length === 0 || deltaMessages.length < this.minMessagesPerBatch) return;

    const toSeqInclusive = Math.max(
      fromSeqExclusive,
      Math.floor(Number(deltaMessages[deltaMessages.length - 1].seq || fromSeqExclusive)),
    );

    const window: IngestionWindow = {
      conversationId: input.conversationId,
      userId: input.userId,
      personaId,
      workspaceId: input.workspaceId,
      fromSeqExclusive,
      toSeqInclusive,
      messages: deltaMessages,
    };

    const result = await this.processWindow(window);
    const wmConfig = getWorldModelConfig();
    if (result.mem0PendingCount > 0 && !wmConfig.enabled && !wmConfig.e2eEnabled) {
      throw new Error(
        `Mem0 persistence incomplete: ${result.mem0PendingCount} fact(s) remain pending; ingestion checkpoint was not advanced.`,
      );
    }
    if (result.worldModelProjected) {
      await upsertWorldModelIngestionCheckpoint({
        conversationId: window.conversationId,
        userId: window.userId,
        personaId: window.personaId,
        workspaceId: window.workspaceId ?? '',
        lastSeq: window.toSeqInclusive,
        sourceWindowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
        committedObservationId: result.worldModelObservationId,
      });
    }
    this.deps.knowledgeRepository.upsertIngestionCheckpoint?.({
      conversationId: window.conversationId,
      userId: window.userId,
      personaId: window.personaId,
      lastSeq: window.toSeqInclusive,
    });
  }

  async runOnce(): Promise<KnowledgeIngestionRunResult> {
    const windows = this.deps.cursor.getPendingWindows();
    let processedConversations = 0;
    let processedMessages = 0;
    let globalMem0FailCount = 0;
    const errors: KnowledgeIngestionError[] = [];

    for (const window of windows) {
      if (window.messages.length < this.minMessagesPerBatch) continue;

      // Global circuit breaker: stop processing windows when Mem0 is unhealthy
      if (globalMem0FailCount >= MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE) {
        console.warn(
          `[KnowledgeIngestion] Global circuit breaker open: ${globalMem0FailCount} cumulative Mem0 failures, skipping remaining windows.`,
        );
        break;
      }

      try {
        const result = await this.processWindow(window);
        globalMem0FailCount += result.mem0FailCount;

        // Back off between windows when Mem0 is showing signs of stress
        if (result.mem0FailCount > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, MEM0_FAILURE_BACKOFF_BASE_MS * result.mem0FailCount),
          );
        }

        const wmConfigLoop = getWorldModelConfig();
        if (result.mem0PendingCount > 0 && !wmConfigLoop.enabled && !wmConfigLoop.e2eEnabled) {
          errors.push({
            conversationId: window.conversationId,
            personaId: window.personaId,
            reason: `Mem0 persistence incomplete: ${result.mem0PendingCount} fact(s) remain pending; window will be retried.`,
          });
          continue;
        }

        if (result.worldModelProjected) {
          await upsertWorldModelIngestionCheckpoint({
            conversationId: window.conversationId,
            userId: window.userId,
            personaId: window.personaId,
            workspaceId: window.workspaceId ?? '',
            lastSeq: window.toSeqInclusive,
            sourceWindowId: `${window.conversationId}:${window.fromSeqExclusive + 1}-${window.toSeqInclusive}`,
            committedObservationId: result.worldModelObservationId,
          });
        }

        this.deps.cursor.markWindowProcessed(window);
        processedConversations += 1;
        processedMessages += window.messages.length;
      } catch (error) {
        errors.push({
          conversationId: window.conversationId,
          personaId: window.personaId,
          reason: error instanceof Error ? error.message : 'Unknown ingestion error',
        });
      }
    }

    return { processedConversations, processedMessages, errors };
  }

  private async processWindow(window: IngestionWindow) {
    const memoryService = this.deps.memoryServiceProvider?.() ?? this.deps.memoryService;
    return processIngestionWindow({
      window,
      extractor: this.deps.extractor,
      repo: this.deps.knowledgeRepository,
      memoryService,
      resolvePersonaName: this.deps.resolvePersonaName,
      markMessagesMemoryPending: this.deps.messageRepository?.markMessagesMemoryPending?.bind(
        this.deps.messageRepository,
      ),
    });
  }
}

export type {
  IngestionWindow,
  KnowledgeIngestionCursor,
  KnowledgeExtractor,
  ExtractionPersonaContext,
};
export type {
  IngestionCursorLike,
  KnowledgeExtractorLike,
  KnowledgeRepositoryLike,
  MemoryServiceLike,
  KnowledgeIngestionServiceDependencies,
  KnowledgeIngestionServiceOptions,
  KnowledgeIngestionError,
  KnowledgeIngestionRunResult,
  IngestConversationWindowInput,
} from './types';
