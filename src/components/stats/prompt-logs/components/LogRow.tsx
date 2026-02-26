'use client';

import React from 'react';
import { PromptLogEntry } from '../types';

interface LogRowProps {
  entry: PromptLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
}

function formatNumber(n: number): string {
  return n.toLocaleString('de-DE');
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

function formatUsd(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}

export const LogRow: React.FC<LogRowProps> = ({ entry, isExpanded, onToggle }) => {
  return (
    <div className="border-b border-zinc-800/70 last:border-b-0">
      <button
        onClick={onToggle}
        className="grid w-full grid-cols-[180px_110px_1fr_130px_130px_90px] gap-3 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900/50"
      >
        <span className="font-mono text-[11px] text-zinc-500">
          {formatTimestamp(entry.createdAt)}
        </span>
        <span className="text-xs font-bold text-zinc-300 capitalize">{entry.providerId}</span>
        <span className="space-y-1">
          <div className="font-mono text-[11px] text-zinc-300">{entry.modelName}</div>
          <div className="line-clamp-2 text-[11px] text-zinc-500">{entry.promptPreview}</div>
        </span>
        <span>
          <div className="font-mono text-sm font-bold text-zinc-200">
            {formatNumber(entry.promptTokens)}
          </div>
          <div
            className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
              entry.promptTokensSource === 'exact'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-violet-500/20 text-violet-300'
            }`}
          >
            {entry.promptTokensSource}
          </div>
        </span>
        <span className="space-y-1">
          <div className="font-mono text-sm font-bold text-zinc-200">
            {formatUsd(entry.promptCostUsd)}
          </div>
          <div className="text-[9px] font-bold tracking-widest text-zinc-500 uppercase">
            prompt usd
          </div>
        </span>
        <span
          className={`inline-flex h-fit rounded px-2 py-0.5 text-[10px] font-black uppercase ${
            entry.riskLevel === 'high'
              ? 'bg-rose-500/20 text-rose-300'
              : entry.riskLevel === 'medium'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-zinc-700/60 text-zinc-300'
          }`}
        >
          {entry.riskLevel}
        </span>
      </button>

      {isExpanded && <LogRowExpanded entry={entry} />}
    </div>
  );
};

interface LogRowExpandedProps {
  entry: PromptLogEntry;
}

const LogRowExpanded: React.FC<LogRowExpandedProps> = ({ entry }) => {
  return (
    <div className="space-y-2 border-t border-zinc-800/60 bg-black/30 px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-4 text-zinc-400">
        <span>
          Status:{' '}
          <span className={entry.status === 'success' ? 'text-emerald-400' : 'text-rose-400'}>
            {entry.status}
          </span>
        </span>
        <span>Dispatch: {entry.dispatchKind}</span>
        <span>Total Tokens: {formatNumber(entry.totalTokens)}</span>
        <span>Completion: {formatNumber(entry.completionTokens)}</span>
        <span>Prompt Cost: {formatUsd(entry.promptCostUsd)}</span>
        <span>Total Cost: {formatUsd(entry.totalCostUsd)}</span>
        <span>Risk Score: {entry.riskScore}</span>
      </div>

      {entry.errorMessage && (
        <div className="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-rose-300">
          {entry.errorMessage}
        </div>
      )}

      {entry.riskReasons.length > 0 && (
        <div className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-200">
          {entry.riskReasons.join(' | ')}
        </div>
      )}

      <pre className="max-h-60 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">
        {entry.promptPayloadJson}
      </pre>
    </div>
  );
};
