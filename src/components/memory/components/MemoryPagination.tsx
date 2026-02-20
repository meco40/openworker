'use client';

import React from 'react';
import type { PaginationState } from '@/components/memory/types';

interface MemoryPaginationProps {
  pagination: PaginationState;
  onPageChange: (page: number) => void;
}

export const MemoryPagination: React.FC<MemoryPaginationProps> = ({ pagination, onPageChange }) => {
  return (
    <div className="mt-4 flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <span className="text-xs text-zinc-500">
        Seite {pagination.page} / {pagination.totalPages} - {pagination.total} Einträge
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
          disabled={pagination.page <= 1}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Zurück
        </button>
        <button
          onClick={() => onPageChange(Math.min(pagination.totalPages, pagination.page + 1))}
          disabled={pagination.page >= pagination.totalPages}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Weiter
        </button>
      </div>
    </div>
  );
};
