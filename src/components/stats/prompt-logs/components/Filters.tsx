'use client';

import React from 'react';
import { RiskFilter } from '../types';

interface FiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  provider: string;
  onProviderChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  risk: RiskFilter;
  onRiskChange: (value: RiskFilter) => void;
  providers: string[];
  models: string[];
}

export const Filters: React.FC<FiltersProps> = ({
  search,
  onSearchChange,
  provider,
  onProviderChange,
  model,
  onModelChange,
  risk,
  onRiskChange,
  providers,
  models,
}) => {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        placeholder="Search prompts..."
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        className="min-w-56 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
      />

      <select
        value={provider}
        onChange={(event) => onProviderChange(event.target.value)}
        className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 focus:border-violet-500 focus:outline-none"
      >
        <option value="all">Provider</option>
        {providers.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>

      <select
        value={model}
        onChange={(event) => onModelChange(event.target.value)}
        className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 focus:border-violet-500 focus:outline-none"
      >
        <option value="all">Model</option>
        {models.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>

      <select
        value={risk}
        onChange={(event) => onRiskChange(event.target.value as RiskFilter)}
        className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 focus:border-violet-500 focus:outline-none"
      >
        <option value="all">Risk</option>
        <option value="flagged">Flagged</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </div>
  );
};
