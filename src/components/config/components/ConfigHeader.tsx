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
  hasChanges,
  isSaving,
  isLoading,
  canApply,
  onReload,
  onOpenDiffPreview,
}) => {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 pb-3">
      {/* Title + description */}
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-900/40 text-indigo-400"
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z"
              clipRule="evenodd"
            />
          </svg>
        </span>
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Gateway Config</h2>
          <p className="text-xs text-zinc-500">Simple tabbed setup with advanced JSON editing.</p>
        </div>
      </div>

      {/* Dirty state indicator */}
      {hasChanges && (
        <span className="flex items-center gap-1.5 rounded-full border border-amber-700/50 bg-amber-900/30 px-2.5 py-1 text-[10px] font-medium text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
          Unsaved changes
        </span>
      )}
      {!hasChanges && !isLoading && (
        <span className="flex items-center gap-1.5 rounded-full border border-emerald-800/40 bg-emerald-900/20 px-2.5 py-1 text-[10px] font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Synced
        </span>
      )}

      {/* Actions */}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-label="Reload config"
          disabled={isLoading || isSaving}
          onClick={onReload}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
              clipRule="evenodd"
            />
          </svg>
          Reload
        </button>

        <button
          type="button"
          aria-label="Open apply preview"
          disabled={!canApply}
          onClick={onOpenDiffPreview}
          className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
            canApply
              ? 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500'
              : 'cursor-not-allowed bg-zinc-800 text-zinc-600'
          }`}
        >
          {isSaving ? (
            <>
              <svg
                className="h-3.5 w-3.5 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
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
              Saving…
            </>
          ) : (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
              </svg>
              Apply Config
            </>
          )}
        </button>
      </div>
    </header>
  );
};
