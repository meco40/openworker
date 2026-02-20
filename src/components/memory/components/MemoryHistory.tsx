'use client';

import React from 'react';
import type { MemoryNode } from '@/core/memory/types';
import type { MemoryHistoryEntry } from '@/components/memory/types';

interface MemoryHistoryProps {
  node: MemoryNode;
  history: MemoryHistoryEntry[] | undefined;
  isLoading: boolean;
  restoringId: string | null;
  onRestore: (node: MemoryNode, entry: MemoryHistoryEntry) => void;
}

export const MemoryHistory: React.FC<MemoryHistoryProps> = ({
  node,
  history,
  isLoading,
  restoringId,
  onRestore,
}) => {
  return (
    <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">
        Verlauf
      </div>
      {isLoading && <div className="text-xs text-zinc-500">History wird geladen...</div>}
      {!isLoading && (!history || history.length === 0) && (
        <div className="text-xs text-zinc-500">Keine History-Einträge vorhanden.</div>
      )}
      {!isLoading &&
        (history || []).map((entry) => (
          <div
            key={`${node.id}:${entry.index}:${entry.timestamp}`}
            className="mb-2 rounded border border-zinc-800 bg-zinc-900/40 p-2 last:mb-0"
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-zinc-400">
                {entry.action} · {entry.timestamp} · v{Number(entry.version || 1)}
              </div>
              <button
                onClick={() => onRestore(node, entry)}
                disabled={restoringId === node.id || !String(entry.content || '').trim()}
                className="rounded border border-amber-800/70 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-950/30 disabled:opacity-40"
              >
                Wiederherstellen
              </button>
            </div>
            <div className="text-xs leading-relaxed text-zinc-300">
              {String(entry.content || '').trim() || '(Kein Inhalt)'}
            </div>
          </div>
        ))}
    </div>
  );
};
