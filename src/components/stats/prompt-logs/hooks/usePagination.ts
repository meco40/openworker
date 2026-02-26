'use client';

import { useCallback } from 'react';
import { PromptLogEntry } from '../types';

interface UsePaginationOptions {
  entries: PromptLogEntry[];
  fetchPage: (cursor?: string, append?: boolean) => Promise<void>;
}

interface UsePaginationReturn {
  loadMore: () => void;
}

export function usePagination({ entries, fetchPage }: UsePaginationOptions): UsePaginationReturn {
  const loadMore = useCallback(() => {
    if (entries.length === 0) return;
    const cursor = entries[entries.length - 1]?.createdAt;
    if (!cursor) return;
    void fetchPage(cursor, true);
  }, [entries, fetchPage]);

  return { loadMore };
}
