'use client';

import React from 'react';

interface PaginationProps {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export const Pagination: React.FC<PaginationProps> = ({ hasMore, loadingMore, onLoadMore }) => {
  if (!hasMore) return null;

  return (
    <div className="flex justify-center">
      <button
        onClick={onLoadMore}
        disabled={loadingMore}
        className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
      >
        {loadingMore ? 'Loading...' : 'Load More'}
      </button>
    </div>
  );
};
