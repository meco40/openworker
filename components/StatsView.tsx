'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts';
import PromptLogsTab from './stats/PromptLogsTab';

// ── Types ────────────────────────────────────────────────────────

interface TokenTotal {
  prompt: number;
  completion: number;
  total: number;
}

interface ModelUsage {
  provider: string;
  model: string;
  prompt: number;
  completion: number;
  total: number;
}

interface StatsResponse {
  ok: boolean;
  overview: {
    uptimeSeconds: number;
    totalRequests: number;
  };
  tokenUsage: {
    total: TokenTotal;
    byModel: ModelUsage[];
  };
  error?: string;
}

type Preset = 'today' | 'week' | 'month' | 'custom';
type StatsTab = 'overview' | 'logs';

// ── Helpers ──────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString('de-DE');
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function truncateModel(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

const CHART_COLORS = [
  '#8b5cf6',
  '#6366f1',
  '#a78bfa',
  '#818cf8',
  '#c084fc',
  '#7c3aed',
  '#4f46e5',
  '#7e22ce',
  '#6d28d9',
  '#5b21b6',
  '#4c1d95',
  '#312e81',
];

// ── Component ────────────────────────────────────────────────────

const StatsView: React.FC = () => {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [activeTab, setActiveTab] = useState<StatsTab>('overview');
  const [logsReloadKey, setLogsReloadKey] = useState(0);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (preset === 'custom') {
        if (customFrom) params.set('from', new Date(customFrom).toISOString());
        if (customTo) params.set('to', new Date(customTo).toISOString());
      } else {
        params.set('preset', preset);
      }

      const response = await fetch(`/api/stats?${params.toString()}`);
      const json = (await response.json()) as StatsResponse;

      if (!json.ok) {
        setError(json.error || 'Failed to load stats.');
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // ── Render ─────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    if (activeTab === 'overview') {
      void fetchStats();
      return;
    }
    setLogsReloadKey((prev) => prev + 1);
  }, [activeTab, fetchStats]);

  return (
    <div className="animate-in fade-in space-y-6 duration-700">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black tracking-tight text-white">Usage Statistics</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Token consumption & model analytics</p>
        </div>
        <button
          onClick={handleRefresh}
          className="flex items-center space-x-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-300 transition-colors hover:bg-zinc-700"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <span>Refresh</span>
        </button>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
            activeTab === 'overview'
              ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
            activeTab === 'logs'
              ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
              : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          }`}
        >
          Logs
        </button>
      </div>

      {/* Time Filter Bar */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-wrap items-center space-x-2 gap-y-2">
          <span className="mr-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Filter
          </span>
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPreset(p)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
                preset === p
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
            >
              {p === 'today' ? 'Heute' : p === 'week' ? 'Diese Woche' : 'Dieser Monat'}
            </button>
          ))}
          <button
            onClick={() => setPreset('custom')}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
              preset === 'custom'
                ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            Zeitraum
          </button>

          {preset === 'custom' && (
            <div className="ml-4 flex items-center space-x-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
              />
              <span className="text-xs text-zinc-600">–</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
              />
            </div>
          )}
        </div>
      </div>

      {activeTab === 'logs' && (
        <PromptLogsTab
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          reloadKey={logsReloadKey}
        />
      )}

      {activeTab === 'overview' && (
        <>
      {/* Loading / Error */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Overview Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {[
              {
                label: 'Uptime',
                value: formatUptime(data.overview.uptimeSeconds),
                detail: 'Server Process',
                icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
                color: 'emerald',
              },
              {
                label: 'Total Requests',
                value: formatNumber(data.overview.totalRequests),
                detail: 'AI Dispatches',
                icon: 'M13 10V3L4 14h7v7l9-11h-7z',
                color: 'violet',
              },
              {
                label: 'Total Tokens',
                value: formatNumber(data.tokenUsage.total.total),
                detail: `${formatNumber(data.tokenUsage.total.prompt)} prompt / ${formatNumber(data.tokenUsage.total.completion)} completion`,
                icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01',
                color: 'indigo',
              },
              {
                label: 'Active Models',
                value: data.tokenUsage.byModel.length,
                detail: 'Distinct Provider+Model',
                icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
                color: 'amber',
              },
            ].map((card, i) => (
              <div
                key={i}
                className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-lg transition-all hover:border-violet-500/30"
              >
                <div
                  className={`absolute top-0 right-0 h-16 w-16 bg-${card.color}-500/5 -mt-8 -mr-8 rounded-full blur-2xl`}
                />
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    {card.label}
                  </span>
                  <svg
                    className={`h-5 w-5 text-${card.color}-500 transition-transform group-hover:scale-110`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d={card.icon}
                    />
                  </svg>
                </div>
                <div className="text-2xl font-black text-white">{card.value}</div>
                <div className="mt-1 font-mono text-[10px] text-zinc-600 uppercase">
                  {card.detail}
                </div>
              </div>
            ))}
          </div>

          {/* Token Breakdown Chart + Table */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Bar Chart */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
              <div className="mb-6 flex items-center justify-between">
                <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
                  <div className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  <span>Token Distribution</span>
                </h3>
                <div className="font-mono text-[9px] text-zinc-500 uppercase">Per Model</div>
              </div>
              {data.tokenUsage.byModel.length === 0 ? (
                <div className="flex h-64 items-center justify-center">
                  <span className="text-[10px] font-black text-zinc-600 uppercase">
                    No token usage recorded in this period.
                  </span>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart
                    data={data.tokenUsage.byModel.map((m) => ({
                      name: truncateModel(m.model, 16),
                      prompt: m.prompt,
                      completion: m.completion,
                      total: m.total,
                    }))}
                    margin={{ top: 5, right: 5, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis
                      dataKey="name"
                      tick={{ fill: '#71717a', fontSize: 9, fontWeight: 'bold' }}
                      axisLine={{ stroke: '#27272a' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: '#71717a', fontSize: 9 }}
                      axisLine={{ stroke: '#27272a' }}
                      tickLine={false}
                      tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#18181b',
                        border: '1px solid #3f3f46',
                        borderRadius: '8px',
                        fontSize: '11px',
                        color: '#d4d4d8',
                      }}
                      formatter={(value: unknown, name: unknown) => [
                        formatNumber(Number(value ?? 0)),
                        String(name ?? ''),
                      ]}
                    />
                    <Bar dataKey="prompt" stackId="tokens" name="Prompt" radius={[0, 0, 0, 0]}>
                      {data.tokenUsage.byModel.map((_entry, index) => (
                        <Cell
                          key={`prompt-${index}`}
                          fill={CHART_COLORS[index % CHART_COLORS.length]}
                          opacity={0.6}
                        />
                      ))}
                    </Bar>
                    <Bar
                      dataKey="completion"
                      stackId="tokens"
                      name="Completion"
                      radius={[4, 4, 0, 0]}
                    >
                      {data.tokenUsage.byModel.map((_entry, index) => (
                        <Cell
                          key={`comp-${index}`}
                          fill={CHART_COLORS[index % CHART_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Model Breakdown Table */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
              <div className="mb-6 flex items-center justify-between">
                <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
                  <div className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                  <span>Model Breakdown</span>
                </h3>
                <div className="font-mono text-[9px] text-zinc-500 uppercase">
                  {data.tokenUsage.byModel.length} Models
                </div>
              </div>

              {data.tokenUsage.byModel.length === 0 ? (
                <div className="flex h-64 items-center justify-center">
                  <span className="text-[10px] font-black text-zinc-600 uppercase">
                    No data available.
                  </span>
                </div>
              ) : (
                <div className="scrollbar-hide max-h-[280px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="px-2 py-2 text-left text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                          Provider
                        </th>
                        <th className="px-2 py-2 text-left text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                          Model
                        </th>
                        <th className="px-2 py-2 text-right text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                          Prompt
                        </th>
                        <th className="px-2 py-2 text-right text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                          Completion
                        </th>
                        <th className="px-2 py-2 text-right text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tokenUsage.byModel.map((entry, i) => {
                        const pct =
                          data.tokenUsage.total.total > 0
                            ? (entry.total / data.tokenUsage.total.total) * 100
                            : 0;
                        return (
                          <tr
                            key={`${entry.provider}-${entry.model}`}
                            className="border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30"
                          >
                            <td className="px-2 py-2.5">
                              <span
                                className="mr-2 inline-block h-2 w-2 rounded-full"
                                style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                              />
                              <span className="font-bold text-zinc-400 capitalize">
                                {entry.provider}
                              </span>
                            </td>
                            <td className="px-2 py-2.5 font-mono text-zinc-300">
                              {truncateModel(entry.model)}
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono text-zinc-400">
                              {formatNumber(entry.prompt)}
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono text-zinc-400">
                              {formatNumber(entry.completion)}
                            </td>
                            <td className="px-2 py-2.5 text-right">
                              <div className="flex items-center justify-end space-x-2">
                                <span className="font-mono font-bold text-white">
                                  {formatNumber(entry.total)}
                                </span>
                                <span className="w-10 text-right font-mono text-[9px] text-zinc-600">
                                  {pct.toFixed(1)}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Token Summary Footer */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center space-x-2 text-xs font-black tracking-widest text-white uppercase">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                <span>Token Summary</span>
              </h3>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div className="text-center">
                <div className="mb-1 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Prompt Tokens
                </div>
                <div className="font-mono text-2xl font-black text-violet-400">
                  {formatNumber(data.tokenUsage.total.prompt)}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400 transition-all duration-700"
                    style={{
                      width: `${data.tokenUsage.total.total > 0 ? (data.tokenUsage.total.prompt / data.tokenUsage.total.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
              <div className="text-center">
                <div className="mb-1 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Completion Tokens
                </div>
                <div className="font-mono text-2xl font-black text-indigo-400">
                  {formatNumber(data.tokenUsage.total.completion)}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-indigo-400 transition-all duration-700"
                    style={{
                      width: `${data.tokenUsage.total.total > 0 ? (data.tokenUsage.total.completion / data.tokenUsage.total.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
              <div className="text-center">
                <div className="mb-1 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Gesamt
                </div>
                <div className="font-mono text-2xl font-black text-white">
                  {formatNumber(data.tokenUsage.total.total)}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-700"
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );
};

export default StatsView;
