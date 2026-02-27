'use client';

import React from 'react';

interface ConflictWarningProps {
  onReload: () => void;
  onRetry: () => void;
}

export const ConflictWarning: React.FC<ConflictWarningProps> = ({ onReload, onRetry }) => {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-wrap items-start gap-3 rounded-xl border border-red-700/50 bg-red-950/30 px-4 py-3.5"
    >
      {/* Icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="mt-0.5 h-5 w-5 shrink-0 text-red-400"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>

      {/* Message */}
      <div className="flex-1">
        <p className="text-xs font-semibold text-red-200">Revision conflict detected</p>
        <p className="mt-0.5 text-xs text-red-400">
          The config was modified externally since you last loaded it. Reload to get the latest
          version, or retry to force-apply your changes.
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReload}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Reload latest
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          Force apply
        </button>
      </div>
    </div>
  );
};
