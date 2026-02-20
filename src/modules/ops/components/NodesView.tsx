'use client';

import React from 'react';
import { useOpsNodes } from '@/modules/ops/hooks/useOpsNodes';

function formatLeaseAge(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h`;
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

const NodesView: React.FC = () => {
  const state = useOpsNodes();
  const data = state.data?.nodes;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Nodes</h2>
          <p className="text-sm text-zinc-400">
            Runtime diagnostics across gateway health, channels, rooms and automation.
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

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Health Status" value={data?.health.status ?? 'unknown'} />
        <MetricCard label="Doctor Findings" value={data?.doctor.findings ?? 0} />
        <MetricCard label="Active Rules" value={data?.automation.activeRules ?? 0} />
        <MetricCard
          label="Lease Age"
          value={formatLeaseAge(data?.automation.leaseAgeSeconds ?? null)}
        />
      </section>

      {state.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-300">
          Loading node diagnostics...
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-100">Diagnostics</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                <div className="font-semibold text-zinc-200">Health</div>
                <div className="mt-1">Status: {data?.health.status ?? 'unknown'}</div>
                <div>
                  Summary: ok {data?.health.summary.ok ?? 0}, warning{' '}
                  {data?.health.summary.warning ?? 0}, critical {data?.health.summary.critical ?? 0}
                </div>
              </div>
              <div className="rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                <div className="font-semibold text-zinc-200">Doctor</div>
                <div className="mt-1">Status: {data?.doctor.status ?? 'unknown'}</div>
                <div>Recommendations: {data?.doctor.recommendations ?? 0}</div>
              </div>
            </div>
          </section>

          <section className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50">
            <div className="border-b border-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200">
              Channel Bindings
            </div>
            {!data?.channels.length ? (
              <div className="px-4 py-6 text-sm text-zinc-400">No channel bindings found.</div>
            ) : (
              <table className="w-full min-w-[780px] text-left text-xs">
                <thead className="border-b border-zinc-800 text-zinc-500 uppercase">
                  <tr>
                    <th className="px-4 py-3">Channel</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Peer</th>
                    <th className="px-4 py-3">Transport</th>
                    <th className="px-4 py-3">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.map((channel) => (
                    <tr
                      key={`${channel.channel}:${channel.externalPeerId || 'none'}`}
                      className="border-b border-zinc-800/80 text-zinc-200"
                    >
                      <td className="px-4 py-3">{channel.channel}</td>
                      <td className="px-4 py-3">{channel.status}</td>
                      <td className="px-4 py-3">
                        {channel.peerName || channel.externalPeerId || 'n/a'}
                      </td>
                      <td className="px-4 py-3">{channel.transport || 'n/a'}</td>
                      <td className="px-4 py-3">{channel.lastSeenAt || 'n/a'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default NodesView;
