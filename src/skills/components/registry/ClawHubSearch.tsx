'use client';

import React from 'react';
import type { ClawHubSearchItem } from '@/skills/clawhub-client';

interface ClawHubSearchProps {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onReset: () => void;
  results: ClawHubSearchItem[];
  warnings: string[];
  loading: boolean;
  onInstall: (slug: string) => void;
}

export const ClawHubSearch: React.FC<ClawHubSearchProps> = ({
  query,
  onQueryChange,
  onSearch,
  onReset,
  results,
  warnings,
  loading,
  onInstall,
}) => (
  <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-sm font-black tracking-widest text-white uppercase">ClawHub Search</h3>
      <button
        onClick={onSearch}
        disabled={loading || !query.trim()}
        className="rounded-xl bg-indigo-600 px-4 py-2 text-[10px] font-black tracking-widest uppercase hover:bg-indigo-500 disabled:opacity-50"
      >
        Search
      </button>
    </div>
    <div className="relative mb-4">
      <input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search ClawHub skills..."
        className="w-full rounded-xl border border-zinc-700 bg-zinc-800 p-3 pr-10 font-mono text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
      />
      <button
        type="button"
        aria-label="Clear ClawHub search"
        onClick={onReset}
        disabled={!query.trim()}
        className="absolute top-1/2 right-2 h-6 w-6 -translate-y-1/2 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-black text-zinc-400 uppercase hover:border-zinc-500 hover:text-white disabled:opacity-40"
      >
        x
      </button>
    </div>

    <div className="max-h-60 space-y-2 overflow-auto pr-1">
      {results.map((item) => (
        <div
          key={`${item.slug}:${item.version}`}
          className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700 bg-zinc-800/60 px-3 py-2"
        >
          <div>
            <p className="text-xs font-semibold text-white">{item.title}</p>
            <p className="font-mono text-[10px] text-zinc-500">
              {item.slug} · v{item.version}
            </p>
          </div>
          <button
            onClick={() => onInstall(item.slug)}
            disabled={loading}
            className="text-[10px] font-black tracking-widest text-indigo-400 uppercase hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Install
          </button>
        </div>
      ))}
    </div>
    {warnings.length > 0 && (
      <p className="mt-3 text-[10px] text-amber-400">Parser warnings: {warnings.length}</p>
    )}
  </div>
);
