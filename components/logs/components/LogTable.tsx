'use client';

import React from 'react';
import type { LogEntry } from '../diagnostics';
import { LogRow } from './LogRow';

interface LogTableProps {
  logs: LogEntry[];
  filteredLogs: LogEntry[];
  isLoading: boolean;
  copiedId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onCopyLog: (log: LogEntry) => void;
  search: string;
  levelFilter: string;
  sourceFilter: string;
  categoryFilter: string;
}

export const LogTable: React.FC<LogTableProps> = ({
  logs,
  filteredLogs,
  isLoading,
  copiedId,
  scrollRef,
  onScroll,
  onCopyLog,
  search,
  levelFilter,
  sourceFilter,
  categoryFilter,
}) => {
  const hasFilters = search || levelFilter !== 'all' || sourceFilter !== 'all' || categoryFilter !== 'all';

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-black/50 font-mono text-xs shadow-2xl">
      {/* Table Header */}
      <div className="flex shrink-0 items-center border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5 font-black tracking-tighter text-zinc-500 uppercase select-none">
        <span className="w-20 shrink-0">Time</span>
        <span className="w-16 shrink-0">Level</span>
        <span className="w-24 shrink-0">Source</span>
        <span className="flex-1">Message</span>
        <span className="w-20 shrink-0 text-right">Age</span>
      </div>

      {/* Log Rows */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center space-x-3 text-zinc-600">
              <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-xs font-bold uppercase">Loading logs...</span>
            </div>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-12 text-center">
            <svg
              className="mb-4 h-12 w-12 text-zinc-800"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span className="text-sm font-bold text-zinc-700">No log entries</span>
            <span className="mt-1 text-[10px] font-bold tracking-wider text-zinc-800 uppercase">
              {hasFilters ? 'Try adjusting your filters' : 'Waiting for system activity...'}
            </span>
          </div>
        ) : (
          <div className="divide-y divide-zinc-900/50">
            {filteredLogs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                isCopied={copiedId === log.id}
                onCopy={onCopyLog}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
