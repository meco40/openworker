'use client';

import React from 'react';
import { useOpsInstances } from '@/modules/ops/hooks/useOpsInstances';
import type { OpsInstancesConnectionSummary } from '@/modules/ops/types';
import { formatDateTime, formatNumber } from '@/shared/lib/dateFormat';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diffMs = Date.now() - parsed;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

interface MetricCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: 'default' | 'emerald' | 'indigo';
}

function MetricCard({ label, value, icon, accent = 'default' }: MetricCardProps) {
  const accentClass =
    accent === 'emerald'
      ? 'border-emerald-500/20 bg-emerald-500/5'
      : accent === 'indigo'
        ? 'border-indigo-500/20 bg-indigo-500/5'
        : 'border-zinc-800 bg-zinc-900/60';

  const valueClass =
    accent === 'emerald'
      ? 'text-emerald-300'
      : accent === 'indigo'
        ? 'text-indigo-300'
        : 'text-white';

  return (
    <div className={`rounded-xl border p-5 transition-colors ${accentClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            {label}
          </div>
          <div className={`text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
        </div>
        <div className="mt-0.5 text-zinc-600">{icon}</div>
      </div>
    </div>
  );
}

// ─── Connection row ───────────────────────────────────────────────────────────

function ConnectionRow({ connection }: { connection: OpsInstancesConnectionSummary }) {
  return (
    <tr className="group border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/20">
      {/* Connection ID */}
      <td className="px-4 py-3">
        <span className="rounded-md bg-zinc-800/60 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
          {connection.connId}
        </span>
      </td>

      {/* Connected at */}
      <td className="px-4 py-3">
        <div className="space-y-0.5">
          <div className="text-xs text-zinc-300">
            {formatDateTime(connection.connectedAt, {
              format: {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              },
            })}
          </div>
          <div className="text-[10px] text-zinc-600">
            {formatRelativeTime(connection.connectedAt)}
          </div>
        </div>
      </td>

      {/* Subscriptions */}
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            connection.subscriptionCount > 0
              ? 'bg-indigo-500/10 text-indigo-300'
              : 'bg-zinc-800 text-zinc-500'
          }`}
        >
          {connection.subscriptionCount}
        </span>
      </td>

      {/* Requests */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-zinc-300 tabular-nums">
          {formatNumber(connection.requestCount)}
        </span>
      </td>

      {/* Seq */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-zinc-500 tabular-nums">{connection.seq}</span>
      </td>
    </tr>
  );
}

// ─── Loading state ────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <section className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-6 text-sm text-zinc-400">
      <svg
        className="h-4 w-4 animate-spin text-zinc-500"
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
      Loading instance telemetry...
    </section>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <section className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 px-5 py-10 text-center">
      <svg
        className="h-8 w-8 text-zinc-700"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"
        />
      </svg>
      <p className="text-sm text-zinc-500">No active connections for this user.</p>
    </section>
  );
}

// ─── InstancesView ────────────────────────────────────────────────────────────

const InstancesView: React.FC = () => {
  const state = useOpsInstances();
  const data = state.data?.instances;
  const generatedAt = state.data?.instances.generatedAt;

  return (
    <div className="animate-in fade-in space-y-6 duration-300">
      {/* ── Page header ── */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Instances</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            Live gateway connection telemetry for your operator scope.
          </p>
          {generatedAt && (
            <p className="mt-1 font-mono text-[10px] text-zinc-600">
              Last updated:{' '}
              {formatDateTime(generatedAt, {
                format: {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                },
              })}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            void state.refresh();
          }}
          disabled={state.loading || state.refreshing}
          className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Refresh instance telemetry"
        >
          <svg
            className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {state.refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {/* ── Error banner ── */}
      {state.error && (
        <div
          className="flex items-center gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3"
          role="alert"
        >
          <svg
            className="h-4 w-4 shrink-0 text-rose-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <p className="text-sm text-rose-300">{state.error}</p>
        </div>
      )}

      {/* ── KPI cards ── */}
      <section className="grid gap-4 md:grid-cols-3" aria-label="Instance metrics">
        <MetricCard
          label="Global Connections"
          value={data?.global.connectionCount ?? 0}
          accent="default"
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"
              />
            </svg>
          }
        />
        <MetricCard
          label="Connected Users"
          value={data?.global.userCount ?? 0}
          accent="emerald"
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
              />
            </svg>
          }
        />
        <MetricCard
          label="My Connections"
          value={data?.currentUser.connectionCount ?? 0}
          accent="indigo"
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          }
        />
      </section>

      {/* ── Connection table ── */}
      {state.loading ? (
        <LoadingState />
      ) : data && data.currentUser.connections.length === 0 ? (
        <EmptyState />
      ) : (
        <section
          className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50"
          aria-label="Active connections"
        >
          <div className="border-b border-zinc-800/60 px-4 py-3">
            <h3 className="text-xs font-bold tracking-widest text-zinc-500 uppercase">
              Active Connections
              {data && (
                <span className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                  {data.currentUser.connections.length}
                </span>
              )}
            </h3>
          </div>

          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="border-b border-zinc-800/60">
              <tr className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
                <th className="px-4 py-3" scope="col">
                  Connection ID
                </th>
                <th className="px-4 py-3" scope="col">
                  Connected
                </th>
                <th className="px-4 py-3" scope="col">
                  Subscriptions
                </th>
                <th className="px-4 py-3" scope="col">
                  Requests
                </th>
                <th className="px-4 py-3" scope="col">
                  Seq
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.currentUser.connections.map((connection) => (
                <ConnectionRow key={connection.connId} connection={connection} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
};

export default InstancesView;
