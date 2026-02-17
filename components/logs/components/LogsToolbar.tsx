'use client';

import React from 'react';
import type { LevelFilter } from '../diagnostics';

interface LogsToolbarProps {
  search: string;
  onSearchChange: (search: string) => void;
  levelFilter: LevelFilter;
  onLevelFilterChange: (level: LevelFilter) => void;
  sourceFilter: string;
  onSourceFilterChange: (source: string) => void;
  categoryFilter: string;
  onCategoryFilterChange: (category: string) => void;
  sources: string[];
  categories: string[];
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
  logsCount: number;
  onExport: () => void;
  onClear: () => void;
}

export const LogsToolbar: React.FC<LogsToolbarProps> = ({
  search,
  onSearchChange,
  levelFilter,
  onLevelFilterChange,
  sourceFilter,
  onSourceFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  sources,
  categories,
  autoScroll,
  onToggleAutoScroll,
  logsCount,
  onExport,
  onClear,
}) => {
  return (
    <div className="flex items-center space-x-2">
      {/* Search */}
      <div className="relative flex-1">
        <svg
          className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900/80 py-2 pr-4 pl-10 text-sm text-zinc-300 placeholder-zinc-600 transition-colors focus:border-zinc-600 focus:outline-none"
        />
      </div>

      {/* Level Filter */}
      <select
        value={levelFilter}
        onChange={(e) => onLevelFilterChange(e.target.value as LevelFilter)}
        className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 transition-colors focus:border-zinc-600 focus:outline-none"
      >
        <option value="all">ALL LEVELS</option>
        <option value="info">INFO</option>
        <option value="warn">WARNINGS</option>
        <option value="error">ERRORS</option>
        <option value="debug">DEBUG</option>
      </select>

      {/* Source Filter */}
      <select
        value={sourceFilter}
        onChange={(e) => onSourceFilterChange(e.target.value)}
        className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 transition-colors focus:border-zinc-600 focus:outline-none"
      >
        <option value="all">ALL SOURCES</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {/* Category Filter */}
      <select
        value={categoryFilter}
        onChange={(e) => onCategoryFilterChange(e.target.value)}
        className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 transition-colors focus:border-zinc-600 focus:outline-none"
      >
        <option value="all">ALL CATEGORIES</option>
        {categories.map((category) => (
          <option key={category} value={category}>
            {category.toUpperCase()}
          </option>
        ))}
      </select>

      {/* Auto-scroll toggle */}
      <button
        onClick={onToggleAutoScroll}
        className={`rounded-lg border px-3 py-2 text-xs font-bold transition-all ${
          autoScroll
            ? 'border-violet-500/30 bg-violet-500/10 text-violet-400'
            : 'border-zinc-800 bg-zinc-900/80 text-zinc-500 hover:text-zinc-300'
        }`}
        title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 14l-7 7m0 0l-7-7m7 7V3"
          />
        </svg>
      </button>

      {/* Export */}
      <button
        onClick={onExport}
        disabled={logsCount === 0}
        className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-400 transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
        title="Export as JSON"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        disabled={logsCount === 0}
        className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-4 py-2 text-xs font-bold text-zinc-400 uppercase transition-all hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-30"
      >
        Clear
      </button>
    </div>
  );
};
