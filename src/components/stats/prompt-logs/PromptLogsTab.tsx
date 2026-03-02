'use client';

import React from 'react';
import { PromptLogsTabProps } from './types';
import { usePromptLogs } from './hooks';
import { Filters, LogsTable, Pagination } from './components';
import {
  formatDateTime as formatDateTimeShared,
  formatNumber as formatNumberShared,
} from '@/shared/lib/dateFormat';

function formatNumber(n: number): string {
  return formatNumberShared(n, 'de-DE');
}

function formatUsd(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}

function formatDateTime(value: string | null): string {
  return formatDateTimeShared(value, {
    locale: 'de-DE',
    format: {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
    },
  });
}

const PromptLogsTab: React.FC<PromptLogsTabProps> = ({
  preset,
  customFrom,
  customTo,
  reloadKey,
}) => {
  const {
    entries,
    summary,
    total,
    loading,
    loadingMore,
    resetting,
    error,
    filters,
    expandedId,
    providers,
    models,
    hasMore,
    diagnostics,
    setFilters,
    setExpandedId,
    loadMore,
    resetLogs,
  } = usePromptLogs({
    preset,
    customFrom,
    customTo,
    reloadKey,
  });

  const totalPromptTokens = summary?.promptTokensTotal ?? 0;
  const totalCostsUsd = summary?.totalCostUsd ?? 0;

  const handleToggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 shadow-lg">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-black tracking-widest text-white uppercase">
            Prompt Dispatch Logs
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            All outbound prompts with token usage and injection risk.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={resetLogs}
            disabled={resetting}
            className="rounded-lg border border-rose-700/60 bg-rose-950/40 px-3 py-1.5 text-[11px] font-bold text-rose-200 transition-colors hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resetting ? 'Resetting...' : 'Reset All Data'}
          </button>
          <div className="text-right text-[11px] text-zinc-500">
            <div>{formatNumber(total)} entries</div>
            <div>{formatNumber(totalPromptTokens)} prompt tokens</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Total
          </div>
          <div className="mt-1 font-mono text-xl font-black text-white">
            {formatNumber(summary?.totalEntries ?? 0)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Flagged
          </div>
          <div className="mt-1 font-mono text-xl font-black text-amber-400">
            {formatNumber(summary?.flaggedEntries ?? 0)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Exact Tokens
          </div>
          <div className="mt-1 font-mono text-xl font-black text-emerald-400">
            {formatNumber(summary?.promptTokensExactCount ?? 0)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Estimated Tokens
          </div>
          <div className="mt-1 font-mono text-xl font-black text-violet-400">
            {formatNumber(summary?.promptTokensEstimatedCount ?? 0)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Costs
          </div>
          <div className="mt-1 font-mono text-xl font-black text-cyan-300">
            {formatUsd(totalCostsUsd)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-400">
        <div className="mb-1 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Logger Diagnostics
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Logger:{' '}
            <span className={diagnostics.loggerActive ? 'text-emerald-400' : 'text-rose-400'}>
              {diagnostics.loggerActive ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </span>
          <span>Attempts Since Boot: {formatNumber(diagnostics.attemptsSinceBoot)}</span>
          <span>Writes Since Boot: {formatNumber(diagnostics.writesSinceBoot)}</span>
          <span>Last Attempt: {formatDateTime(diagnostics.lastAttemptAt)}</span>
          <span>Last Insert: {formatDateTime(diagnostics.lastInsertAt)}</span>
          <span>
            Last Error:{' '}
            <span className={diagnostics.lastError ? 'text-rose-300' : 'text-zinc-500'}>
              {diagnostics.lastError || 'none'}
            </span>
          </span>
        </div>
      </div>

      <Filters
        search={filters.search}
        onSearchChange={(search) => setFilters({ search })}
        provider={filters.provider}
        onProviderChange={(provider) => setFilters({ provider })}
        model={filters.model}
        onModelChange={(model) => setFilters({ model })}
        risk={filters.risk}
        onRiskChange={(risk) => setFilters({ risk })}
        providers={providers}
        models={models}
      />

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      <LogsTable
        entries={entries}
        loading={loading}
        expandedId={expandedId}
        onToggleExpand={handleToggleExpand}
      />

      <Pagination hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} />
    </div>
  );
};

export default PromptLogsTab;
export { PromptLogsTab };
