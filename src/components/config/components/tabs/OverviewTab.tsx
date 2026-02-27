'use client';

import React from 'react';
import type { ConfigWarning } from '@/components/config/types';

interface OverviewTabProps {
  configSource: 'default' | 'file' | 'unknown';
  hasChanges: boolean;
  compatibilityWarnings: ConfigWarning[];
}

const SOURCE_DESCRIPTIONS: Record<OverviewTabProps['configSource'], string> = {
  file: 'Loaded from a custom config file on disk.',
  default: 'Using built-in defaults. No custom file found.',
  unknown: 'Source could not be determined.',
};

export const OverviewTab: React.FC<OverviewTabProps> = ({
  configSource,
  hasChanges,
  compatibilityWarnings,
}) => {
  return (
    <div className="space-y-5">
      {/* Status cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Config source */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
            Config Source
          </p>
          <p className="text-sm font-semibold text-zinc-200 capitalize">{configSource}</p>
          <p className="mt-1 text-[11px] text-zinc-600">{SOURCE_DESCRIPTIONS[configSource]}</p>
        </div>

        {/* Pending changes */}
        <div
          className={`rounded-xl border p-4 ${
            hasChanges
              ? 'border-amber-800/50 bg-amber-950/20'
              : 'border-zinc-800 bg-zinc-900/60'
          }`}
        >
          <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
            Pending Changes
          </p>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${hasChanges ? 'bg-amber-400' : 'bg-emerald-500'}`}
              aria-hidden="true"
            />
            <p
              className={`text-sm font-semibold ${
                hasChanges ? 'text-amber-300' : 'text-emerald-400'
              }`}
            >
              {hasChanges ? 'Unsaved changes' : 'Up to date'}
            </p>
          </div>
          <p className="mt-1 text-[11px] text-zinc-600">
            {hasChanges
              ? 'Use "Apply Config" to save your changes.'
              : 'Config matches the saved state.'}
          </p>
        </div>

        {/* Warnings */}
        <div
          className={`rounded-xl border p-4 ${
            compatibilityWarnings.length > 0
              ? 'border-orange-800/50 bg-orange-950/20'
              : 'border-zinc-800 bg-zinc-900/60'
          }`}
        >
          <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
            Compatibility Warnings
          </p>
          <p
            className={`text-sm font-semibold ${
              compatibilityWarnings.length > 0 ? 'text-orange-300' : 'text-zinc-400'
            }`}
          >
            {compatibilityWarnings.length === 0
              ? 'None'
              : `${String(compatibilityWarnings.length)} warning${compatibilityWarnings.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {/* Warning list */}
      {compatibilityWarnings.length > 0 && (
        <div className="rounded-xl border border-orange-800/40 bg-orange-950/20 px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold tracking-wider text-orange-400 uppercase">
            Compatibility Issues
          </p>
          <ul className="space-y-1.5">
            {compatibilityWarnings.map((w) => (
              <li key={w.code} className="flex items-start gap-2 text-xs text-orange-300">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="mt-px h-3.5 w-3.5 shrink-0 text-orange-400"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>
                  <span className="font-mono text-[10px] text-orange-500">[{w.code}]</span>{' '}
                  {w.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
