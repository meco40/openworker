'use client';
import React from 'react';

interface FlowToolbarProps {
  ruleName: string;
  isDirty: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
  onBack: () => void;
}

export function FlowToolbar({
  ruleName,
  isDirty,
  saving,
  saveError,
  onSave,
  onBack,
}: FlowToolbarProps) {
  return (
    <div className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4">
      <button
        type="button"
        onClick={onBack}
        className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
      >
        ← Back
      </button>

      <span className="flex-1 truncate text-sm font-semibold text-zinc-200">{ruleName}</span>

      {isDirty && <span className="text-[11px] text-amber-500">Unsaved changes</span>}

      {saveError && (
        <span className="max-w-[200px] truncate text-[11px] text-red-400" title={saveError}>
          {saveError}
        </span>
      )}

      <button
        type="button"
        onClick={onSave}
        disabled={saving || !isDirty}
        className="rounded border border-zinc-600 bg-zinc-800 px-4 py-1 text-xs text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
