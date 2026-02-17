'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import type { PaginationState, MemoryApiResponse } from '../types';

interface UseMemoryOptions {
  selectedPersonaId: string | null;
  page: number;
  pageSize: number;
  debouncedQuery: string;
  typeFilter: 'all' | MemoryType;
}

export function useMemory(options: UseMemoryOptions) {
  const { selectedPersonaId, page, pageSize, debouncedQuery, typeFilter } = options;

  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadMemory = useCallback(
    async (
      personaId: string,
      options?: {
        page?: number;
        pageSize?: number;
        query?: string;
        type?: 'all' | MemoryType;
      },
    ) => {
      const pageToLoad = options?.page ?? page;
      const pageSizeToLoad = options?.pageSize ?? pageSize;
      const queryToLoad = options?.query ?? debouncedQuery;
      const typeToLoad = options?.type ?? typeFilter;

      const params = new URLSearchParams({
        personaId,
        page: String(pageToLoad),
        pageSize: String(pageSizeToLoad),
      });
      if (queryToLoad.trim()) {
        params.set('query', queryToLoad.trim());
      }
      if (typeToLoad !== 'all') {
        params.set('type', typeToLoad);
      }

      setLoading(true);
      try {
        const response = await fetch(`/api/memory?${params.toString()}`, {
          cache: 'no-store',
        });
        const payload = (await response.json()) as MemoryApiResponse;
        if (response.ok && payload.ok && Array.isArray(payload.nodes)) {
          setErrorMessage(null);
          setNodes(payload.nodes);
          setPagination(
            payload.pagination ?? {
              page: pageToLoad,
              pageSize: pageSizeToLoad,
              total: payload.nodes.length,
              totalPages: 1,
            },
          );
          return payload.nodes;
        } else {
          setErrorMessage(String(payload.error || 'Memory konnte nicht geladen werden.'));
          setNodes([]);
          setPagination((previous) => ({ ...previous, total: 0, totalPages: 1 }));
          return [];
        }
      } catch {
        setErrorMessage('Memory konnte nicht geladen werden.');
        setNodes([]);
        setPagination((previous) => ({ ...previous, total: 0, totalPages: 1 }));
        return [];
      } finally {
        setLoading(false);
      }
    },
    [debouncedQuery, page, pageSize, typeFilter],
  );

  const reloadCurrent = useCallback(async () => {
    if (!selectedPersonaId) return;
    await loadMemory(selectedPersonaId, {
      page,
      pageSize,
      query: debouncedQuery,
      type: typeFilter,
    });
  }, [debouncedQuery, loadMemory, page, pageSize, selectedPersonaId, typeFilter]);

  // Load memory when dependencies change
  useEffect(() => {
    if (!selectedPersonaId) return;
    void loadMemory(selectedPersonaId, { page, pageSize, query: debouncedQuery, type: typeFilter });
  }, [debouncedQuery, loadMemory, page, pageSize, selectedPersonaId, typeFilter]);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  return {
    nodes,
    setNodes,
    loading,
    pagination,
    errorMessage,
    setErrorMessage,
    loadMemory,
    reloadCurrent,
    clearError,
  };
}
