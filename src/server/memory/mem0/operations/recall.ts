/**
 * Search/recall memory operations for Mem0 client
 */

import type {
  Mem0SearchInput,
  Mem0ListInput,
  Mem0SearchHit,
  Mem0ListMemoryResult,
  Mem0MemoryRecord,
} from '../types';
import {
  extractHits,
  extractHistory,
  extractMemories,
  toMemoryRecord,
  extractListMeta,
  pickRecord,
} from '../utils';
import { normalizeText, isV2UnavailableError } from '../utils/http';

/**
 * Create search memories operation
 */
export function createSearchOperation(
  request: (
    path: string,
    init: { method: 'POST'; body?: Record<string, unknown> },
  ) => Promise<unknown>,
  requestV2: (
    path: string,
    init: { method: 'POST'; body?: Record<string, unknown> },
  ) => Promise<unknown>,
) {
  return async function searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]> {
    const baseFilters: Record<string, unknown> = {
      user_id: input.userId,
      agent_id: input.personaId,
      ...input.filters,
    };

    try {
      const payload = await requestV2('/memories/search', {
        method: 'POST',
        body: {
          query: input.query,
          filters: baseFilters,
          top_k: input.limit,
          limit: input.limit,
        },
      });
      return extractHits(payload);
    } catch (error) {
      if (!isV2UnavailableError(error)) throw error;
    }

    const payload = await request('/search', {
      method: 'POST',
      body: {
        query: input.query,
        user_id: input.userId,
        agent_id: input.personaId,
        top_k: input.limit,
        limit: input.limit,
      },
    });
    return extractHits(payload);
  };
}

/**
 * Create list memories operation
 */
export function createListOperation(
  request: (
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  ) => Promise<unknown>,
  requestV2: (
    path: string,
    init: { method: 'POST'; body?: Record<string, unknown> },
  ) => Promise<unknown>,
) {
  return async function listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult> {
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    const filters: Record<string, unknown> = {
      user_id: input.userId,
    };
    if (input.personaId) {
      filters.agent_id = input.personaId;
    }
    if (input.type) {
      filters.type = input.type;
    }

    try {
      const payload = await requestV2('/memories', {
        method: 'POST',
        body: {
          filters,
          page,
          page_size: pageSize,
          ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        },
      });

      const memories = extractMemories(payload)
        .map((entry) => toMemoryRecord(entry))
        .filter((entry): entry is Mem0MemoryRecord => entry !== null);
      const meta = extractListMeta(payload, page, pageSize);
      const total = meta.total > 0 ? meta.total : memories.length;

      return {
        memories,
        total,
        page: meta.page,
        pageSize: meta.pageSize,
      };
    } catch (error) {
      if (!isV2UnavailableError(error)) throw error;
    }

    const params = new URLSearchParams({
      user_id: input.userId,
    });
    if (input.personaId) {
      params.set('agent_id', input.personaId);
    }
    const fallbackPayload = await request(`/memories?${params.toString()}`, {
      method: 'GET',
    });

    const trimmedQuery = input.query ? normalizeText(input.query) : '';
    const memories = extractMemories(fallbackPayload)
      .map((entry) => toMemoryRecord(entry))
      .filter((entry): entry is Mem0MemoryRecord => entry !== null)
      .filter((entry) => {
        if (!input.type) return true;
        return String(entry.metadata.type || '').trim() === input.type;
      })
      .filter((entry) => {
        if (!trimmedQuery) return true;
        return normalizeText(entry.content).includes(trimmedQuery);
      });

    const total = memories.length;
    const start = (page - 1) * pageSize;
    const paged = memories.slice(start, start + pageSize);

    return {
      memories: paged,
      total,
      page,
      pageSize,
    };
  };
}

/**
 * Create get memory operation
 */
export function createGetOperation(
  request: (path: string, init: { method: 'GET' }) => Promise<unknown>,
) {
  return async function getMemory(id: string): Promise<Mem0MemoryRecord | null> {
    const payload = await request(`/memories/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
    const direct = toMemoryRecord(payload);
    if (direct) return direct;
    return toMemoryRecord(pickRecord(payload).memory);
  };
}

/**
 * Create get memory history operation
 */
export function createGetHistoryOperation(
  request: (path: string, init: { method: 'GET' }) => Promise<unknown>,
) {
  return async function getMemoryHistory(id: string) {
    const payload = await request(`/memories/${encodeURIComponent(id)}/history`, {
      method: 'GET',
    });
    return extractHistory(payload);
  };
}
