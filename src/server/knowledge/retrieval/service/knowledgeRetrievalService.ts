import type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
} from '@/server/knowledge/retrieval/types';

import { COUNTERPART_CACHE_TTL_MS } from './constants';
import { getKnownCounterparts, type CounterpartCacheEntry } from './counterpartCache';
import { shouldTriggerRecallForQuery } from './queryPlanning';
import { executeKnowledgeRetrieval } from './retrievalExecution';

export class KnowledgeRetrievalService {
  private readonly maxContextTokens: number;
  private readonly counterpartCache = new Map<string, CounterpartCacheEntry>();
  private readonly counterpartCacheTtlMs = COUNTERPART_CACHE_TTL_MS;

  constructor(private readonly options: KnowledgeRetrievalServiceOptions) {
    this.maxContextTokens = Math.max(1, Math.floor(options.maxContextTokens || 1200));
  }

  async shouldTriggerRecall(input: KnowledgeRecallProbeInput): Promise<boolean> {
    const knownCounterparts = getKnownCounterparts({
      userId: input.userId,
      personaId: input.personaId,
      cache: this.counterpartCache,
      ttlMs: this.counterpartCacheTtlMs,
      knowledgeRepository: this.options.knowledgeRepository,
    });

    return shouldTriggerRecallForQuery(input, knownCounterparts);
  }

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    return executeKnowledgeRetrieval({
      input,
      options: this.options,
      maxContextTokens: this.maxContextTokens,
    });
  }
}
