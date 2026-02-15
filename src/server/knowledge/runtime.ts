import type { MessageRepository } from '../channels/messages/repository';
import { SqliteMessageRepository } from '../channels/messages/sqliteMessageRepository';
import { getMemoryService } from '../memory/runtime';
import { getKnowledgeConfig } from './config';
import { KnowledgeExtractor } from './extractor';
import { KnowledgeIngestionCursor } from './ingestionCursor';
import { KnowledgeIngestionService } from './ingestionService';
import { KnowledgeRetrievalService } from './retrievalService';
import type { KnowledgeRepository } from './repository';
import { SqliteKnowledgeRepository } from './sqliteKnowledgeRepository';
import { KnowledgeRuntimeLoop } from './runtimeLoop';

declare global {
  var __knowledgeMessageRepository: MessageRepository | undefined;
  var __knowledgeRepository: KnowledgeRepository | undefined;
  var __knowledgeExtractor: KnowledgeExtractor | undefined;
  var __knowledgeCursor: KnowledgeIngestionCursor | undefined;
  var __knowledgeIngestionService: KnowledgeIngestionService | undefined;
  var __knowledgeRetrievalService: KnowledgeRetrievalService | undefined;
  var __knowledgeRuntimeLoop: KnowledgeRuntimeLoop | undefined;
}

function getKnowledgeMessageRepository(): MessageRepository {
  const sharedRepository = globalThis.__messageRepository as MessageRepository | undefined;
  if (sharedRepository) return sharedRepository;

  if (!globalThis.__knowledgeMessageRepository) {
    globalThis.__knowledgeMessageRepository = new SqliteMessageRepository();
  }
  return globalThis.__knowledgeMessageRepository;
}

export function getKnowledgeRepository(): KnowledgeRepository {
  if (!globalThis.__knowledgeRepository) {
    globalThis.__knowledgeRepository = new SqliteKnowledgeRepository();
  }
  return globalThis.__knowledgeRepository;
}

export function getKnowledgeExtractor(): KnowledgeExtractor {
  if (!globalThis.__knowledgeExtractor) {
    globalThis.__knowledgeExtractor = new KnowledgeExtractor();
  }
  return globalThis.__knowledgeExtractor;
}

export function getKnowledgeIngestionCursor(): KnowledgeIngestionCursor {
  if (!globalThis.__knowledgeCursor) {
    globalThis.__knowledgeCursor = new KnowledgeIngestionCursor(
      getKnowledgeMessageRepository(),
      getKnowledgeRepository(),
    );
  }
  return globalThis.__knowledgeCursor;
}

export function getKnowledgeIngestionService(): KnowledgeIngestionService {
  if (!globalThis.__knowledgeIngestionService) {
    globalThis.__knowledgeIngestionService = new KnowledgeIngestionService({
      cursor: getKnowledgeIngestionCursor(),
      extractor: getKnowledgeExtractor(),
      knowledgeRepository: getKnowledgeRepository(),
      memoryService: getMemoryService(),
    });
  }
  return globalThis.__knowledgeIngestionService;
}

export function getKnowledgeRetrievalService(): KnowledgeRetrievalService {
  if (!globalThis.__knowledgeRetrievalService) {
    const config = getKnowledgeConfig();
    globalThis.__knowledgeRetrievalService = new KnowledgeRetrievalService({
      maxContextTokens: config.maxContextTokens,
      knowledgeRepository: getKnowledgeRepository(),
      memoryService: getMemoryService(),
      messageRepository: getKnowledgeMessageRepository(),
    });
  }
  return globalThis.__knowledgeRetrievalService;
}

export function getKnowledgeRuntimeLoop(): KnowledgeRuntimeLoop {
  if (!globalThis.__knowledgeRuntimeLoop) {
    const config = getKnowledgeConfig();
    globalThis.__knowledgeRuntimeLoop = new KnowledgeRuntimeLoop({
      enabled: config.layerEnabled && (config.episodeEnabled || config.ledgerEnabled),
      intervalMs: config.ingestIntervalMs,
      runIngestion: async () => {
        await getKnowledgeIngestionService().runOnce();
      },
    });
  }
  return globalThis.__knowledgeRuntimeLoop;
}

export function startKnowledgeRuntimeLoop(): KnowledgeRuntimeLoop {
  const loop = getKnowledgeRuntimeLoop();
  loop.start();
  return loop;
}

export function stopKnowledgeRuntimeLoop(): void {
  globalThis.__knowledgeRuntimeLoop?.stop();
}

export function resetKnowledgeRuntimeForTests(): void {
  globalThis.__knowledgeRuntimeLoop?.stop();
  globalThis.__knowledgeMessageRepository = undefined;
  globalThis.__knowledgeRuntimeLoop = undefined;
  globalThis.__knowledgeRetrievalService = undefined;
  globalThis.__knowledgeIngestionService = undefined;
  globalThis.__knowledgeCursor = undefined;
  globalThis.__knowledgeExtractor = undefined;
  globalThis.__knowledgeRepository = undefined;
}
