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

export class KnowledgeIngestionService {
  private readonly minMessagesPerBatch: number;

  constructor(
    private readonly deps: KnowledgeIngestionServiceDependencies,
    options: KnowledgeIngestionServiceOptions = {},
  ) {
    const configured = Math.floor(Number(options.minMessagesPerBatch || 1));
    this.minMessagesPerBatch = Number.isFinite(configured) ? Math.max(1, configured) : 1;
  }

  async ingestConversationWindow(input: IngestConversationWindowInput): Promise<void> {
    const personaId = String(input.personaId || '').trim();
    if (!personaId) return;

    const sortedMessages = [...(input.messages || [])]
      .filter((message) => Number.isFinite(Number(message.seq)))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    if (sortedMessages.length === 0) return;

    const checkpoint = this.deps.knowledgeRepository.getIngestionCheckpoint?.(
      input.conversationId,
      personaId,
    );
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
      fromSeqExclusive,
      toSeqInclusive,
      messages: deltaMessages,
    };

    await this.processWindow(window);
    this.deps.knowledgeRepository.upsertIngestionCheckpoint?.({
      conversationId: window.conversationId,
      personaId: window.personaId,
      lastSeq: window.toSeqInclusive,
    });
  }

  async runOnce(): Promise<KnowledgeIngestionRunResult> {
    const windows = this.deps.cursor.getPendingWindows();
    let processedConversations = 0;
    let processedMessages = 0;
    const errors: KnowledgeIngestionError[] = [];

    for (const window of windows) {
      if (window.messages.length < this.minMessagesPerBatch) continue;
      try {
        await this.processWindow(window);
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

  private async processWindow(window: IngestionWindow): Promise<void> {
    await processIngestionWindow({
      window,
      extractor: this.deps.extractor,
      repo: this.deps.knowledgeRepository,
      memoryService: this.deps.memoryService,
      resolvePersonaName: this.deps.resolvePersonaName,
    });
  }
}

export type { IngestionWindow, KnowledgeIngestionCursor, KnowledgeExtractor, ExtractionPersonaContext };
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
