import type { MessageRepository } from '../channels/messages/repository';
import { SqliteMessageRepository } from '../channels/messages/sqliteMessageRepository';
import { getModelHubService, getModelHubEncryptionKey } from '../model-hub/runtime';
import { getMemoryService } from '../memory/runtime';
import { getKnowledgeConfig } from './config';
import { KnowledgeExtractor } from './extractor';
import { KnowledgeIngestionCursor } from './ingestionCursor';
import { KnowledgeIngestionService } from './ingestionService';
import { KnowledgeRetrievalService } from './retrievalService';
import type { KnowledgeRepository } from './repository';
import { SqliteKnowledgeRepository } from './sqliteKnowledgeRepository';
import { KnowledgeRuntimeLoop } from './runtimeLoop';
import { detectPlaceholder, detectStaleRelativeTime, detectLowRelevance } from './cleanupDetector';
import { detectOrphans } from './reconciliation';
import { getPersonaRepository } from '../personas/personaRepository';
import type { PersonaType } from './personaStrategies';

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

/**
 * Sends a prompt to the model hub for knowledge extraction.
 * Uses the default pipeline with the first active model (profile 'p1').
 */
async function runExtractionModelViaHub(prompt: string): Promise<string> {
  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();
  const result = await service.dispatchWithFallback('p1', encryptionKey, {
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    auditContext: { kind: 'knowledge-extraction' },
  });
  if (!result.ok) {
    throw new Error(`Knowledge extraction model call failed: ${result.error || 'unknown'}`);
  }
  return result.text;
}

export function getKnowledgeExtractor(): KnowledgeExtractor {
  if (!globalThis.__knowledgeExtractor) {
    globalThis.__knowledgeExtractor = new KnowledgeExtractor({
      runExtractionModel: runExtractionModelViaHub,
    });
  }
  return globalThis.__knowledgeExtractor;
}

export function getKnowledgeIngestionCursor(): KnowledgeIngestionCursor {
  if (!globalThis.__knowledgeCursor) {
    const config = getKnowledgeConfig();
    globalThis.__knowledgeCursor = new KnowledgeIngestionCursor(
      getKnowledgeMessageRepository(),
      getKnowledgeRepository(),
      { minMessagesPerBatch: config.minMessagesPerBatch },
    );
  }
  return globalThis.__knowledgeCursor;
}

function tryGetMemoryService(): ReturnType<typeof getMemoryService> | null {
  try {
    return getMemoryService();
  } catch (err) {
    console.warn(
      '[knowledge] Mem0 unavailable — Mem0 storage will be skipped during ingestion.',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function getKnowledgeIngestionService(): KnowledgeIngestionService {
  if (!globalThis.__knowledgeIngestionService) {
    const config = getKnowledgeConfig();
    globalThis.__knowledgeIngestionService = new KnowledgeIngestionService(
      {
        cursor: getKnowledgeIngestionCursor(),
        extractor: getKnowledgeExtractor(),
        knowledgeRepository: getKnowledgeRepository(),
        memoryService: tryGetMemoryService(),
        resolvePersonaName: (personaId: string) => {
          try {
            const persona = getPersonaRepository().getPersona(personaId);
            return persona?.name ?? null;
          } catch {
            return null;
          }
        },
      },
      { minMessagesPerBatch: config.minMessagesPerBatch },
    );
  }
  return globalThis.__knowledgeIngestionService;
}

export function getKnowledgeRetrievalService(): KnowledgeRetrievalService {
  if (!globalThis.__knowledgeRetrievalService) {
    const config = getKnowledgeConfig();
    globalThis.__knowledgeRetrievalService = new KnowledgeRetrievalService({
      maxContextTokens: config.maxContextTokens,
      knowledgeRepository: getKnowledgeRepository(),
      memoryService: tryGetMemoryService(),
      messageRepository: getKnowledgeMessageRepository(),
      getPersonaMemoryType: (personaId: string): PersonaType | null => {
        const persona = getPersonaRepository().getPersona(personaId);
        return (persona?.memoryPersonaType as PersonaType) ?? null;
      },
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
      runCleanup: async () => {
        // Scan knowledge episodes for placeholder, stale, and low-relevance content
        const repo = getKnowledgeRepository();
        const episodes = repo.listEpisodes({ userId: '%', personaId: '%', limit: 50 });
        let cleanedCount = 0;
        for (const episode of episodes) {
          for (const fact of episode.facts || []) {
            if (detectPlaceholder(fact) || detectLowRelevance(fact)) {
              cleanedCount++;
            }
            if (episode.updatedAt && detectStaleRelativeTime(fact, episode.updatedAt)) {
              cleanedCount++;
            }
          }
        }
        if (cleanedCount > 0) {
          console.log(`[knowledge] cleanup detected ${cleanedCount} stale/placeholder facts`);
        }
      },
      runReconciliation: async () => {
        // Compare Mem0 entries with knowledge episodes to find orphans
        try {
          const repo = getKnowledgeRepository();
          const episodes = repo.listEpisodes({ userId: '%', personaId: '%', limit: 100 });
          const knowledgeEntries = episodes.map((e) => ({
            id: e.id || '',
            content: e.teaser || '',
          }));
          // Mem0 recall is async — only run if we have knowledge entries
          if (knowledgeEntries.length > 0) {
            const report = detectOrphans([], knowledgeEntries);
            if (report.knowledgeOrphansFound > 0 || report.mem0OrphansFound > 0) {
              console.log(
                `[knowledge] reconciliation: ${report.mem0OrphansFound} Mem0 orphans, ${report.knowledgeOrphansFound} knowledge orphans`,
              );
            }
          }
        } catch (reconcileError) {
          console.warn('[knowledge] reconciliation skipped:', reconcileError);
        }
      },
      maintenanceEveryNthTick: 10,
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
