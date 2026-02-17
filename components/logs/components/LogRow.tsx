'use client';

import React from 'react';
import { LEVEL_CONFIG, SOURCE_COLORS, formatTimestamp, relativeTime, type LogEntry } from '../diagnostics';

interface LogRowProps {
  log: LogEntry;
  isCopied: boolean;
  onCopy: (log: LogEntry) => void;
}

export const LogRow: React.FC<LogRowProps> = ({ log, isCopied, onCopy }) => {
  const config = LEVEL_CONFIG[log.level] || LEVEL_CONFIG.info;
  const sourceColor = SOURCE_COLORS[log.source] || 'text-indigo-400';

  return (
    <div
      onClick={() => onCopy(log)}
      className={`group flex cursor-pointer items-start px-4 py-1.5 transition-colors hover:bg-zinc-900/50 ${
        log.level === 'error' ? 'bg-rose-500/[0.03]' : ''
      }`}
      title="Click to copy"
    >
      <span className="w-20 shrink-0 text-zinc-600 tabular-nums">
        {formatTimestamp(log.timestamp)}
      </span>
      <span className={`w-16 shrink-0 font-black ${config.color}`}>
        [{log.level.toUpperCase()}]
      </span>
      <span className={`w-24 shrink-0 font-bold ${sourceColor}`}>{log.source}</span>
      <span className="flex-1 break-all text-zinc-400 transition-colors group-hover:text-zinc-200">
        <span className="mr-2 text-zinc-600">[{log.category}]</span>
        {log.message}
      </span>
      <span className="w-20 shrink-0 text-right text-zinc-700 tabular-nums">
        {isCopied ? (
          <span className="font-bold text-emerald-500">Copied!</span>
        ) : (
          relativeTime(log.createdAt)
        )}
      </span>
    </div>
  );
};
