'use client';

import React from 'react';
import { useOpsAgents } from '@/modules/ops/hooks/useOpsAgents';

function formatDateTime(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

const AgentsView: React.FC = () => {
  const state = useOpsAgents();
  const data = state.data?.agents;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Agents</h2>
          <p className="text-sm text-zinc-400">Persona snapshots for active agent operations.</p>
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

      {state.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-300">
          Loading agent runtime snapshot...
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Personas</h3>
            {!data?.personas.length ? (
              <div className="text-sm text-zinc-400">No personas found for this user.</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.personas.map((persona) => (
                  <article
                    key={persona.id}
                    className="rounded border border-zinc-800 bg-zinc-950/70 p-3"
                  >
                    <div className="text-sm font-semibold text-zinc-100">
                      {persona.emoji} {persona.name}
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">{persona.vibe || 'no vibe'}</div>
                    <div className="mt-2 text-[11px] text-zinc-500">
                      updated {formatDateTime(persona.updatedAt)}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default AgentsView;
