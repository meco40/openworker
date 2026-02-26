/**
 * Knowledge retrieval service module entrypoint.
 * Keep this file lean: exports only.
 */

export { KnowledgeRetrievalService } from './knowledgeRetrievalService';

export type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
} from '@/server/knowledge/retrieval/types';

export * from './types';
export * from './constants';
export * from './query';
export * from './ranking';
export * from './formatters';
