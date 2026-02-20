'use client';

import React from 'react';
import { useOpsInstances } from '@/modules/ops/hooks/useOpsInstances';

function formatDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-white">{value}</div>
    </div>
  );
}

const InstancesView: React.FC = () => {
  const state = useOpsInstances();
  const data = state.data?.instances;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Instances</h2>
          <p className="text-sm text-zinc-400">
            Live gateway connection telemetry for your operator scope.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void state.refresh();
          }}
          disabled={state.loading || state.refreshing}
          className="rounded-md border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      {state.error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {state.error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <MetricCard label="Global Connections" value={data?.global.connectionCount ?? 0} />
        <MetricCard label="Connected Users" value={data?.global.userCount ?? 0} />
        <MetricCard label="My Connections" value={data?.currentUser.connectionCount ?? 0} />
      </section>

      {state.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-300">
          Loading instance telemetry...
        </section>
      ) : data && data.currentUser.connections.length === 0 ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          No active connections for this user.
        </section>
      ) : (
        <section className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="border-b border-zinc-800 text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-3">Connection ID</th>
                <th className="px-4 py-3">Connected</th>
                <th className="px-4 py-3">Subscriptions</th>
                <th className="px-4 py-3">Requests</th>
                <th className="px-4 py-3">Seq</th>
              </tr>
            </thead>
            <tbody>
              {data?.currentUser.connections.map((connection) => (
                <tr key={connection.connId} className="border-b border-zinc-800/80 text-zinc-200">
                  <td className="px-4 py-3 font-mono">{connection.connId}</td>
                  <td className="px-4 py-3 text-zinc-300">
                    {formatDateTime(connection.connectedAt)}
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{connection.subscriptionCount}</td>
                  <td className="px-4 py-3 text-zinc-300">{connection.requestCount}</td>
                  <td className="px-4 py-3 text-zinc-300">{connection.seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
};

export default InstancesView;
