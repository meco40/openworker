'use client';

import React from 'react';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import type { EditDraft } from '../types';
import { TYPE_LABEL } from '../types';
import { MemoryHistory } from './MemoryHistory';
import type { MemoryHistoryEntry } from '../types';

interface MemoryNodeItemProps {
  node: MemoryNode;
  isEditing: boolean;
  draft: EditDraft | null;
  isSelected: boolean;
  isDeleting: boolean;
  isSaving: boolean;
  expandedHistoryId: string | null;
  history: MemoryHistoryEntry[] | undefined;
  isHistoryLoading: boolean;
  restoringId: string | null;
  onToggleSelection: () => void;
  onToggleHistory: () => void;
  onBeginEdit: () => void;
  onDelete: () => void;
  onSave: () => void;
  onCancel: () => void;
  onRestore: (entry: MemoryHistoryEntry) => void;
  onDraftContentChange: (content: string) => void;
  onDraftTypeChange: (type: MemoryType) => void;
  onDraftImportanceChange: (importance: number) => void;
}

export const MemoryNodeItem: React.FC<MemoryNodeItemProps> = ({
  node,
  isEditing,
  draft,
  isSelected,
  isDeleting,
  isSaving,
  expandedHistoryId,
  history,
  isHistoryLoading,
  restoringId,
  onToggleSelection,
  onToggleHistory,
  onBeginEdit,
  onDelete,
  onSave,
  onCancel,
  onRestore,
  onDraftContentChange,
  onDraftTypeChange,
  onDraftImportanceChange,
}) => {
  const isExpanded = expandedHistoryId === node.id;

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelection}
            className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
          />
          <span className="rounded border border-indigo-600/40 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-indigo-300 uppercase">
            {TYPE_LABEL[node.type]}
          </span>
          <span className="text-[11px] text-zinc-500">
            Importance: {node.importance}/5
          </span>
          <span className="text-[11px] text-zinc-500">
            Version: {Number(node.metadata?.version || 1)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleHistory}
            disabled={isHistoryLoading}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {isExpanded ? 'Verlauf ausblenden' : 'Verlauf'}
          </button>
          {!isEditing ? (
            <>
              <button
                onClick={onBeginEdit}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Bearbeiten
              </button>
              <button
                onClick={onDelete}
                disabled={isDeleting}
                className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/30 disabled:opacity-40"
              >
                Löschen
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onSave}
                disabled={isSaving}
                className="rounded border border-emerald-800/70 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-40"
              >
                Speichern
              </button>
              <button
                onClick={onCancel}
                disabled={isSaving}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Abbrechen
              </button>
            </>
          )}
        </div>
      </div>

      {!isEditing ? (
        <div className="space-y-2">
          <p className="text-sm leading-relaxed text-zinc-200">{node.content}</p>
          <div className="text-[11px] text-zinc-500">
            {node.timestamp} · v{Number(node.metadata?.version || 1)}
          </div>
        </div>
      ) : (
        draft && (
          <div className="space-y-2">
            <textarea
              value={draft.content}
              onChange={(event) => onDraftContentChange(event.target.value)}
              className="min-h-[90px] w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
            />
            <div className="flex flex-wrap gap-2">
              <select
                value={draft.type}
                onChange={(event) => onDraftTypeChange(event.target.value as MemoryType)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-indigo-500"
              >
                {Object.entries(TYPE_LABEL).map(([type, label]) => (
                  <option key={type} value={type}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={5}
                value={draft.importance}
                onChange={(event) =>
                  onDraftImportanceChange(Math.min(5, Math.max(1, Number(event.target.value || 1))))
                }
                className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        )
      )}

      {isExpanded && (
        <MemoryHistory
          node={node}
          history={history}
          isLoading={isHistoryLoading}
          restoringId={restoringId}
          onRestore={(_, entry) => onRestore(entry)}
        />
      )}
    </article>
  );
};
