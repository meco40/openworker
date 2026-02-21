'use client';

import React from 'react';
import type { MemoryType } from '@/core/memory/types';
import { MEMORY_TYPES, TYPE_LABEL } from '@/components/memory/types';

interface MemoryToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  typeFilter: 'all' | MemoryType;
  onTypeFilterChange: (type: 'all' | MemoryType) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  selectedPersonaId: string | null;
  loading: boolean;
  onReload: () => void;
  onClearAll: () => void;
  clearingAll: boolean;
  errorMessage: string | null;
  // Bulk operations
  selectedIdsCount: number;
  allPageSelected: boolean;
  onToggleSelectPage: () => void;
  onClearSelection: () => void;
  bulkType: 'keep' | MemoryType;
  onBulkTypeChange: (type: 'keep' | MemoryType) => void;
  bulkImportance: string;
  onBulkImportanceChange: (value: string) => void;
  bulkBusy: boolean;
  onApplyBulkUpdate: () => void;
  onApplyBulkDelete: () => void;
}

export const MemoryToolbar: React.FC<MemoryToolbarProps> = ({
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
  pageSize,
  onPageSizeChange,
  selectedPersonaId,
  loading,
  onReload,
  onClearAll,
  clearingAll,
  errorMessage,
  selectedIdsCount,
  allPageSelected,
  onToggleSelectPage,
  onClearSelection,
  bulkType,
  onBulkTypeChange,
  bulkImportance,
  onBulkImportanceChange,
  bulkBusy,
  onApplyBulkUpdate,
  onApplyBulkDelete,
}) => {
  return (
    <header className="border-b border-zinc-800 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-black tracking-widest text-white uppercase">Memory</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onReload}
            disabled={!selectedPersonaId || loading}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Neu laden
          </button>
          <button
            onClick={onClearAll}
            disabled={!selectedPersonaId || clearingAll}
            className="rounded-md border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
          >
            Export + alle loeschen
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {errorMessage}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Suche nach Inhalt oder Typ..."
          className="min-w-[260px] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        />
        <select
          value={typeFilter}
          onChange={(event) => onTypeFilterChange(event.target.value as 'all' | MemoryType)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        >
          <option value="all">Alle Typen</option>
          {MEMORY_TYPES.map((type) => (
            <option key={type} value={type}>
              {TYPE_LABEL[type]}
            </option>
          ))}
        </select>
        <select
          value={String(pageSize)}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        >
          <option value="25">25 / Seite</option>
          <option value="50">50 / Seite</option>
          <option value="100">100 / Seite</option>
          <option value="200">200 / Seite</option>
        </select>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleSelectPage}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {allPageSelected ? 'Seite abwählen' : 'Seite auswählen'}
          </button>
          <button
            onClick={onClearSelection}
            disabled={selectedIdsCount === 0}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Auswahl löschen
          </button>
          <span className="text-xs text-zinc-500">{selectedIdsCount} ausgewählt</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={bulkType}
            onChange={(event) => onBulkTypeChange(event.target.value as 'keep' | MemoryType)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          >
            <option value="keep">Typ unverändert</option>
            {MEMORY_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            max={5}
            value={bulkImportance}
            onChange={(event) => onBulkImportanceChange(event.target.value)}
            placeholder="Importance"
            className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-indigo-500"
          />
          <button
            onClick={onApplyBulkUpdate}
            disabled={selectedIdsCount === 0 || bulkBusy}
            className="rounded border border-emerald-800/70 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-40"
          >
            Bulk speichern
          </button>
          <button
            onClick={onApplyBulkDelete}
            disabled={selectedIdsCount === 0 || bulkBusy}
            className="rounded border border-red-900/70 px-2 py-1 text-xs text-red-300 hover:bg-red-950/30 disabled:opacity-40"
          >
            Bulk löschen
          </button>
        </div>
      </div>
    </header>
  );
};
