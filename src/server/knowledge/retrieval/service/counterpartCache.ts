import { uniqueStrings } from '@/server/knowledge/retrieval/utils/arrayUtils';
import type { RetrievalKnowledgeRepository } from '@/server/knowledge/retrieval/types';

export interface CounterpartCacheEntry {
  counterparts: string[];
  expiresAt: number;
}

export interface GetKnownCounterpartsArgs {
  userId: string;
  personaId: string;
  cache: Map<string, CounterpartCacheEntry>;
  ttlMs: number;
  knowledgeRepository: RetrievalKnowledgeRepository;
}

export function getKnownCounterparts({
  userId,
  personaId,
  cache,
  ttlMs,
  knowledgeRepository,
}: GetKnownCounterpartsArgs): string[] {
  const cacheKey = `${userId}::${personaId}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.counterparts;
  }

  const filter = { userId, personaId, limit: 60 };
  const ledgerRows = knowledgeRepository.listMeetingLedger(filter);
  const episodes = knowledgeRepository.listEpisodes(filter);

  const counterparts = uniqueStrings([
    ...ledgerRows.map((row) => String(row.counterpart || '').trim()),
    ...episodes.map((row) => String(row.counterpart || '').trim()),
  ]).filter((value) => value.length >= 2);

  cache.set(cacheKey, {
    counterparts,
    expiresAt: now + ttlMs,
  });

  return counterparts;
}
