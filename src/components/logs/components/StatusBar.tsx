'use client';

import React from 'react';

interface StatusBarProps {
  filteredCount: number;
  totalCount: number;
  hasMoreHistory: boolean;
  autoScroll: boolean;
  isConnected: boolean;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  filteredCount,
  totalCount,
  hasMoreHistory,
  autoScroll,
  isConnected,
}) => {
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-4 py-1.5 font-mono text-[10px] text-zinc-600 uppercase">
      <div className="flex items-center space-x-4">
        <span>{filteredCount} entries shown</span>
        {filteredCount !== totalCount && (
          <span className="text-zinc-700">({totalCount} total matching)</span>
        )}
        {hasMoreHistory && <span className="text-zinc-700">more history available</span>}
      </div>
      <div className="flex items-center space-x-4">
        {autoScroll && (
          <span className="flex items-center space-x-1 text-violet-500">
            <span className="h-1 w-1 animate-pulse rounded-full bg-violet-500" />
            <span>Auto-scroll</span>
          </span>
        )}
        <span className={isConnected ? 'text-emerald-600' : 'text-zinc-700'}>
          WS {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </div>
  );
};
