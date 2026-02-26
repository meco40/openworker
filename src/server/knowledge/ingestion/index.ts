/**
 * Knowledge Ingestion Module
 *
 * This module provides knowledge ingestion functionality for processing
 * conversation windows and extracting facts, events, entities, and episodes.
 *
 * @module @/server/knowledge/ingestion
 */

// Re-export all types
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

// Re-export constants
export {
  MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW,
  MEM0_RATE_LIMIT_DELAY_MS,
  DEFAULT_RELATION_CONFIDENCE,
  DEFAULT_EVENT_CONFIDENCE,
  DEFAULT_TOPIC_KEY,
  GERMAN_SELF_REFERENCES,
  ENGLISH_SELF_REFERENCES,
} from './constants';

// Re-export quality checks
export {
  inferSourceStart,
  inferSourceEnd,
  normalizeRuleEvidenceText,
  tokenizeRuleEvidence,
  hasRuleEvidenceMatch,
  collectUserRuleEvidenceTexts,
  keepOnlyEvidenceBackedRuleStatements,
} from './qualityChecks';

// Re-export emotion tracking
export { detectDominantEmotion, detectEmotion } from './emotionTracker';
export type { EmotionDetectionResult } from './emotionTracker';

// Re-export task tracking
export { detectTaskCompletions, detectTaskCompletion } from './taskTracker';
export type { TaskCompletionResult } from './taskTracker';
export type { TrackedTask } from './taskTracker';

// Re-export fact extraction
export { detectCorrections, processFacts, processMeetingLedger, storeFacts } from './factExtractor';
export type {
  CorrectionResult,
  FactProcessingContext,
  FactProcessingResult,
} from './factExtractor';

// Re-export event extraction
export { storeEvents, resolveEventTimes } from './eventExtractor';
export type { EventProcessingContext, EventStorageResult } from './eventExtractor';

// Re-export entity extraction
export {
  storeEntities,
  normalizeSelfReferences,
  validateEventSpeakerRoles,
} from './entityExtractor';
export type { EntityProcessingContext, EntityProcessingResult } from './entityExtractor';

// Re-export episode extraction
export { upsertEpisodeAndLedger } from './episodeExtractor';
export type { EpisodeInput } from './episodeExtractor';

// Re-export task completion
export { storeTaskCompletions } from './taskCompletion';
export type { TaskCompletionResult as TaskCompletionStorageResult } from './taskCompletion';

// Re-export message processing
export {
  processWindow,
  buildPersonaContext,
  normalizeExtractionSelfReferences,
} from './messageProcessor';
export type { ProcessWindowContext, ProcessWindowResult } from './messageProcessor';

// Re-export ingestion cursor types
export type { IngestionWindow, KnowledgeIngestionCursor } from './ingestionCursor';

// Re-export main class from original location for backward compatibility
// This import is re-exported to maintain the same API
export {
  KnowledgeIngestionService,
  type KnowledgeIngestionCursor as KICursor,
  type KnowledgeExtractor,
} from '@/server/knowledge/ingestion/service';

