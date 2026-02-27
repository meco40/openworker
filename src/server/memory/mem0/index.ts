/**
 * Mem0 client module
 *
 * This is the main entry point for the Mem0 client library.
 * It re-exports all public APIs for backward compatibility.
 */

// Types
export type {
  Mem0ClientConfig,
  Mem0MemoryInput,
  Mem0SearchInput,
  Mem0ListInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0ListMemoryResult,
  Mem0HistoryEntry,
  Mem0Client,
  EnvLike,
  RequestOptions,
  RequestInit,
} from './types';

// Constants
export {
  DEFAULT_TIMEOUT_MS,
  TRANSIENT_HTTP_CODES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  MEM0_RUNTIME_UNCONFIGURED_MARKER,
  MEM0_MODEL_HUB_SYNC_COOLDOWN_MS,
} from './constants';

// Client factory functions
export { createMem0Client, createMem0ClientFromEnv, HttpMem0Client } from './client';

// Utility functions
export {
  pickRecord,
  pickString,
  pickNumber,
  extractMemories,
  toMemoryRecord,
  extractHits,
  toHistoryEntry,
  extractHistory,
  extractId,
  extractListMeta,
  extractDeletedCount,
  extractErrorDetail,
} from './utils';

// HTTP utilities
export {
  normalizeBaseUrl,
  normalizeApiPath,
  joinUrl,
  normalizeText,
  isTransientHttpError,
  isTimeoutError,
  isV2UnavailableError,
  isLegacyDeleteFilterError,
  isMem0RuntimeUnconfiguredError,
  isMem0InvalidModelConfigError,
  sleep,
} from './utils/http';

// Sync utilities
export { triggerMem0ModelHubSync, __resetMem0ModelHubSyncStateForTests } from './sync';

// Operations (exported for advanced use)
export { createStoreOperation, createUpdateOperation } from './operations/store';
export {
  createSearchOperation,
  createListOperation,
  createGetOperation,
  createGetHistoryOperation,
} from './operations/recall';
export { createDeleteOperation, createDeleteByFilterOperation } from './operations/delete';
export {
  createFeedbackOperation,
  createGetFeedbackOperation,
  type FeedbackRating,
  type FeedbackInput,
} from './operations/feedback';

// Entity graph (future functionality)
export {
  extractEntities,
  buildEntityGraph,
  findRelatedByEntity,
  type EntityNode,
  type RelationshipEdge,
  type EntityGraph,
} from './entityGraph';

// Episode management (future functionality)
export {
  createEpisode,
  addMemoryToEpisode,
  getEpisodeMemories,
  buildEpisodeMetadata,
  type Episode,
  type CreateEpisodeInput,
} from './episodeManager';

// Deduplication
export {
  calculateSimilarity,
  isDuplicate,
  findDuplicates,
  mergeDuplicates,
  DEFAULT_DUPLICATE_THRESHOLD,
  type DeduplicationOptions,
} from './deduplication';

// Sanitization
export {
  sanitizeString,
  sanitizeMetadata,
  sanitizeMemoryInput,
  sanitizeSearchInput,
  sanitizeListInput,
  validateConfig,
  MAX_CONTENT_LENGTH,
  MAX_METADATA_SIZE,
} from './sanitization';
