'use client';

import React from 'react';

interface AdvancedTabProps {
  config: string;
  isLoading: boolean;
  onChange: (value: string) => void;
}

export const AdvancedTab: React.FC<AdvancedTabProps> = ({ config, isLoading, onChange }) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4 text-zinc-600"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M6.28 5.22a.75.75 0 010 1.06L2.56 10l3.72 3.72a.75.75 0 01-1.06 1.06L.97 10.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0zm7.44 0a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 010-1.06zM11.377 2.011a.75.75 0 01.612.867l-2.5 14.5a.75.75 0 01-1.478-.255l2.5-14.5a.75.75 0 01.866-.612z"
            clipRule="evenodd"
          />
        </svg>
        <p className="text-xs text-zinc-500">
          Edit the raw JSON config directly. Changes here override all tab settings.
        </p>
      </div>
      <div className="relative">
        <textarea
          aria-label="Advanced JSON editor"
          value={config}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          disabled={isLoading}
          className="min-h-[420px] w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-sm leading-relaxed text-indigo-300 transition-colors focus:border-indigo-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-zinc-950/60">
            <svg
              className="h-6 w-6 animate-spin text-zinc-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-label="Loading"
            >
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
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
};
