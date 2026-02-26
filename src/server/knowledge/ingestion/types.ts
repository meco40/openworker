import type { MemoryService } from '@/server/memory/service';
import type {
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
} from '@/server/knowledge/extractor';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { KnowledgeRepository } from '@/server/knowledge/repository';
import type { ExtractionPersonaContext } from '@/server/knowledge/prompts';

export interface IngestionCursorLike {
  getPendingWindows(limitConversations?: number): IngestionWindow[];
  markWindowProcessed(window: IngestionWindow): void;
}

export interface KnowledgeExtractorLike {
  extract(input: KnowledgeExtractionInput): Promise<KnowledgeExtractionResult>;
}

export interface KnowledgeRepositoryLike {
  getIngestionCheckpoint?: KnowledgeRepository['getIngestionCheckpoint'];
  upsertIngestionCheckpoint?: KnowledgeRepository['upsertIngestionCheckpoint'];
  upsertEpisode: KnowledgeRepository['upsertEpisode'];
  upsertMeetingLedger: KnowledgeRepository['upsertMeetingLedger'];
  upsertEvent?: KnowledgeRepository['upsertEvent'];
  findOverlappingEvents?: KnowledgeRepository['findOverlappingEvents'];
  appendEventSources?: KnowledgeRepository['appendEventSources'];
  // Entity Graph (optional — only used when entityGraphEnabled)
  upsertEntity?: KnowledgeRepository['upsertEntity'];
  addAlias?: KnowledgeRepository['addAlias'];
  addRelation?: KnowledgeRepository['addRelation'];
  updateEntityProperties?: KnowledgeRepository['updateEntityProperties'];
  resolveEntity?: KnowledgeRepository['resolveEntity'];
  getEntityWithRelations?: KnowledgeRepository['getEntityWithRelations'];
}

export interface MemoryServiceLike {
  store: (...args: Parameters<MemoryService['store']>) => Promise<unknown>;
}

export interface KnowledgeIngestionServiceDependencies {
  cursor: IngestionCursorLike;
  extractor: KnowledgeExtractorLike;
  knowledgeRepository: KnowledgeRepositoryLike;
  /** Optional — when null/undefined, Mem0 storage is silently skipped. */
  memoryService?: MemoryServiceLike | null;
  /** Optional: resolve persona ID → human-readable name (e.g. "Lea"). */
  resolvePersonaName?: (personaId: string) => string | null;
}

export interface KnowledgeIngestionServiceOptions {
  minMessagesPerBatch?: number;
}

export interface KnowledgeIngestionError {
  conversationId: string;
  personaId: string;
  reason: string;
}

export interface KnowledgeIngestionRunResult {
  processedConversations: number;
  processedMessages: number;
  errors: KnowledgeIngestionError[];
}

export interface IngestConversationWindowInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: IngestionWindow['messages'];
  summaryText?: string;
  personaContext?: ExtractionPersonaContext;
}

// Re-export types from other modules for backward compatibility
export type {
  KnowledgeExtractionInput,
  KnowledgeExtractionResult,
} from '@/server/knowledge/extractor';
export type { IngestionWindow, KnowledgeIngestionCursor } from '@/server/knowledge/ingestionCursor';
