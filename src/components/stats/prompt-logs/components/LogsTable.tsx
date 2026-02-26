'use client';

import React from 'react';
import { PromptLogEntry } from '../types';
import { LogRow } from './LogRow';

interface LogsTableProps {
  entries: PromptLogEntry[];
  loading: boolean;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
}

export const LogsTable: React.FC<LogsTableProps> = ({
  entries,
  loading,
  expandedId,
  onToggleExpand,
}) => {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800">
      <div className="grid grid-cols-[180px_110px_1fr_130px_130px_90px] gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
        <span>Time</span>
        <span>Provider</span>
        <span>Model / Preview</span>
        <span>Prompt Tokens</span>
        <span>Costs</span>
        <span>Risk</span>
      </div>
      <div className="max-h-[520px] overflow-y-auto">
        {loading ? (
          <div className="px-3 py-5 text-xs text-zinc-500">Loading prompt logs...</div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-5 text-xs text-zinc-500">
            No prompt logs found for this filter set.
          </div>
        ) : (
          entries.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              isExpanded={expandedId === entry.id}
              onToggle={() => onToggleExpand(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};
