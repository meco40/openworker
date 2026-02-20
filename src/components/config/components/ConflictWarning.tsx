'use client';

import React from 'react';

interface ConflictWarningProps {
  onReload: () => void;
  onRetry: () => void;
}

export const ConflictWarning: React.FC<ConflictWarningProps> = ({ onReload, onRetry }) => {
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3">
      <div className="mb-2 text-xs text-rose-200">Stale revision detected.</div>
      <div className="flex flex-wrap gap-2">
        <button className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200" onClick={onReload}>
          Reload latest
        </button>
        <button className="rounded bg-indigo-700 px-3 py-1 text-xs text-white" onClick={onRetry}>
          Try apply again
        </button>
      </div>
    </div>
  );
};
