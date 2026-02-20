'use client';

import React from 'react';

interface ConfigHeaderProps {
  hasChanges: boolean;
  isSaving: boolean;
  isLoading: boolean;
  canApply: boolean;
  onReload: () => void;
  onOpenDiffPreview: () => void;
}

export const ConfigHeader: React.FC<ConfigHeaderProps> = ({
  hasChanges: _hasChanges,
  isSaving,
  isLoading,
  canApply,
  onReload,
  onOpenDiffPreview,
}) => {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">Gateway Config</h2>
        <p className="text-sm text-zinc-500">Simple tabbed setup with advanced JSON editing.</p>
      </div>
      <div className="flex space-x-3">
        <button
          aria-label="Reload config"
          disabled={isLoading || isSaving}
          onClick={onReload}
          className="rounded bg-zinc-800 px-4 py-2 text-xs font-bold tracking-widest text-zinc-300 uppercase hover:bg-zinc-700 disabled:opacity-60"
        >
          Reload
        </button>
        <button
          aria-label="Open apply preview"
          disabled={!canApply}
          onClick={onOpenDiffPreview}
          className={`rounded px-6 py-2 text-xs font-bold tracking-widest uppercase transition-all ${
            canApply
              ? 'bg-indigo-600 text-white shadow-lg hover:bg-indigo-700'
              : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
          }`}
        >
          {isSaving ? 'Saving...' : 'Apply Config'}
        </button>
      </div>
    </div>
  );
};
