'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

type Preset = 'today' | 'week' | 'month' | 'custom';
type RiskFilter = 'all' | 'low' | 'medium' | 'high' | 'flagged';

interface PromptLogEntry {
  id: string;
  providerId: string;
  modelName: string;
  dispatchKind: 'chat' | 'summary' | 'worker_planner' | 'worker_executor' | 'api_gateway';
  promptTokens: number;
  promptTokensSource: 'exact' | 'estimated';
  completionTokens: number;
  totalTokens: number;
  status: 'success' | 'error';
  errorMessage: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  riskScore: number;
  riskReasons: string[];
  promptPreview: string;
  promptPayloadJson: string;
  promptCostUsd: number | null;
  completionCostUsd: number | null;
  totalCostUsd: number | null;
  createdAt: string;
}

interface PromptLogSummary {
  totalEntries: number;
  flaggedEntries: number;
  promptTokensTotal: number;
  promptTokensExactCount: number;
  promptTokensEstimatedCount: number;
  totalCostUsd: number;
}

interface PromptLogsResponse {
  ok: boolean;
  entries: PromptLogEntry[];
  total: number;
  summary: PromptLogSummary;
  diagnostics?: PromptLogDiagnostics;
  error?: string;
}

interface PromptLogDiagnostics {
  loggerActive: boolean;
  attemptsSinceBoot: number;
  writesSinceBoot: number;
  lastAttemptAt: string | null;
  lastInsertAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface PromptLogsTabProps {
  preset: Preset;
  customFrom: string;
  customTo: string;
  reloadKey?: number;
}

const EMPTY_SUMMARY: PromptLogSummary = {
  totalEntries: 0,
  flaggedEntries: 0,
  promptTokensTotal: 0,
  promptTokensExactCount: 0,
  promptTokensEstimatedCount: 0,
  totalCostUsd: 0,
};

const EMPTY_DIAGNOSTICS: PromptLogDiagnostics = {
  loggerActive: true,
  attemptsSinceBoot: 0,
  writesSinceBoot: 0,
  lastAttemptAt: null,
  lastInsertAt: null,
  lastError: null,
  lastErrorAt: null,
};

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

const PAGE_SIZE = 100;

function formatDateTime(value: string | null): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
}

const PromptLogsTab: React.FC<PromptLogsTabProps> = ({
  preset,
  customFrom,
  customTo,
  reloadKey,
}) => {
  const [entries, setEntries] = useState<PromptLogEntry[]>([]);
  const [summary, setSummary] = useState<PromptLogSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [risk, setRisk] = useState<RiskFilter>('all');
  const [provider, setProvider] = useState('all');
  const [model, setModel] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PromptLogDiagnostics>(EMPTY_DIAGNOSTICS);

  const updateDistinctValues = useCallback((nextEntries: PromptLogEntry[]) => {
    setProviders((prev) =>
      Array.from(new Set([...prev, ...nextEntries.map((entry) => entry.providerId)])).sort(),
    );
    setModels((prev) =>
      Array.from(new Set([...prev, ...nextEntries.map((entry) => entry.modelName)])).sort(),
    );
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string, append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const params = new URLSearchParams();
        if (preset === 'custom') {
          if (customFrom) params.set('from', new Date(customFrom).toISOString());
          if (customTo) params.set('to', new Date(customTo).toISOString());
        } else {
          params.set('preset', preset);
        }
        if (search.trim()) params.set('search', search.trim());
        if (risk !== 'all') params.set('risk', risk);
        if (provider !== 'all') params.set('provider', provider);
        if (model !== 'all') params.set('model', model);
        params.set('limit', String(PAGE_SIZE));
        if (cursor) params.set('before', cursor);

        const response = await fetch(`/api/stats/prompt-logs?${params.toString()}`);
        const json = (await response.json()) as PromptLogsResponse;

        if (!json.ok) {
          setError(json.error || 'Failed to load prompt logs.');
          return;
        }

        if (append) {
          setEntries((prev) => [...prev, ...json.entries]);
        } else {
          setEntries(json.entries);
          setSummary(json.summary);
          setTotal(json.total);
          if (json.diagnostics) {
            setDiagnostics(json.diagnostics);
          }
          setExpandedId(null);
        }

        updateDistinctValues(json.entries);
        setHasMore(json.entries.length === PAGE_SIZE);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load prompt logs.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [customFrom, customTo, model, preset, provider, risk, search, updateDistinctValues],
  );

  useEffect(() => {
    void fetchPage(undefined, false);
  }, [fetchPage, reloadKey]);

  const loadMore = useCallback(() => {
    if (entries.length === 0) return;
    const cursor = entries[entries.length - 1]?.createdAt;
    if (!cursor) return;
    void fetchPage(cursor, true);
  }, [entries, fetchPage]);

  const totalPromptTokens = useMemo(() => summary?.promptTokensTotal ?? 0, [summary]);
  const totalCostsUsd = useMemo(() => summary?.totalCostUsd ?? 0, [summary]);

  const resetLogs = useCallback(async () => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm('Alle Prompt-Logs und Usage-Statistiken wirklich löschen?');
      if (!confirmed) return;
    }

    setResetting(true);
    setError(null);
    try {
      const response = await fetch('/api/stats/prompt-logs', { method: 'DELETE' });
      const json = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !json.ok) {
        setError(json.error || 'Failed to reset prompt logs.');
        return;
      }
      setEntries([]);
      setSummary(EMPTY_SUMMARY);
      setTotal(0);
      setExpandedId(null);
      setProviders([]);
      setModels([]);
      setDiagnostics(EMPTY_DIAGNOSTICS);
      await fetchPage(undefined, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset prompt logs.');
    } finally {
      setResetting(false);
    }
  }, [fetchPage]);

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
          <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">Costs</div>
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

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search prompts..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-56 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
        />

        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
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
          onChange={(event) => setModel(event.target.value)}
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
          onChange={(event) => setRisk(event.target.value as RiskFilter)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-bold text-zinc-300 focus:border-violet-500 focus:outline-none"
        >
          <option value="all">Risk</option>
          <option value="flagged">Flagged</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <div className="grid grid-cols-[180px_110px_1fr_130px_130px_90px] gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          <span>Time</span>
          <span>Provider</span>
          <span>Model / Preview</span>
          <span>Prompt Tokens</span>
          <span>Costs</span>
          <span>Risk</span>
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          {loading ? (
            <div className="px-3 py-5 text-xs text-zinc-500">Loading prompt logs...</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-5 text-xs text-zinc-500">
              No prompt logs found for this filter set.
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="border-b border-zinc-800/70 last:border-b-0">
                <button
                  onClick={() => setExpandedId((prev) => (prev === entry.id ? null : entry.id))}
                  className="grid w-full grid-cols-[180px_110px_1fr_130px_130px_90px] gap-3 px-3 py-2.5 text-left transition-colors hover:bg-zinc-900/50"
                >
                  <span className="font-mono text-[11px] text-zinc-500">
                    {formatTimestamp(entry.createdAt)}
                  </span>
                  <span className="text-xs font-bold text-zinc-300 capitalize">
                    {entry.providerId}
                  </span>
                  <span className="space-y-1">
                    <div className="font-mono text-[11px] text-zinc-300">{entry.modelName}</div>
                    <div className="line-clamp-2 text-[11px] text-zinc-500">
                      {entry.promptPreview}
                    </div>
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

                {expandedId === entry.id && (
                  <div className="space-y-2 border-t border-zinc-800/60 bg-black/30 px-3 py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-4 text-zinc-400">
                      <span>
                        Status:{' '}
                        <span
                          className={
                            entry.status === 'success' ? 'text-emerald-400' : 'text-rose-400'
                          }
                        >
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
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-bold text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
};

export default PromptLogsTab;
