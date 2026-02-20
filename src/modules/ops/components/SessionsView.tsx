'use client';

import React from 'react';
import { useOpsSessions } from '@/modules/ops/hooks/useOpsSessions';

function formatDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

const SessionsView: React.FC = () => {
  const state = useOpsSessions();
  const sessions = state.data?.sessions || [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Sessions</h2>
          <p className="text-sm text-zinc-400">
            Search and manage persisted conversation sessions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void state.actions.refresh();
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

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
          <label className="space-y-1 text-xs text-zinc-400">
            <span>Search sessions</span>
            <input
              value={state.query}
              onChange={(event) => state.actions.setQuery(event.target.value)}
              placeholder="Search sessions"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            />
          </label>

          <label className="space-y-1 text-xs text-zinc-400">
            <span>New session title</span>
            <input
              value={state.createDraft}
              onChange={(event) => state.actions.setCreateDraft(event.target.value)}
              placeholder="Daily Ops"
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                void state.actions.createSession();
              }}
              disabled={state.pendingConversationId === 'create'}
              className="h-[34px] rounded-md bg-indigo-600 px-3 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state.pendingConversationId === 'create' ? 'Creating...' : 'Create Session'}
            </button>
          </div>
        </div>
      </section>

      {state.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-300">
          Loading sessions...
        </section>
      ) : sessions.length === 0 ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
          No sessions matched the current query.
        </section>
      ) : (
        <section className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="border-b border-zinc-800 text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Persona</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => {
                const isPending = state.pendingConversationId === session.id;
                const renameValue = state.renameDraftById[session.id] ?? session.title;
                return (
                  <tr key={session.id} className="border-b border-zinc-800/80 text-zinc-200">
                    <td className="px-4 py-3">
                      <div className="font-medium">{session.title}</div>
                      <div className="font-mono text-[11px] text-zinc-500">{session.id}</div>
                    </td>
                    <td className="px-4 py-3">{session.channelType}</td>
                    <td className="px-4 py-3">{session.personaId || 'n/a'}</td>
                    <td className="px-4 py-3">{formatDateTime(session.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <input
                          value={renameValue}
                          onChange={(event) =>
                            state.actions.setRenameDraft(session.id, event.target.value)
                          }
                          className="h-7 w-48 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void state.actions.renameSession(session.id);
                          }}
                          disabled={isPending}
                          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              typeof window !== 'undefined' &&
                              !window.confirm(`Delete session "${session.title}"?`)
                            ) {
                              return;
                            }
                            void state.actions.deleteSession(session.id);
                          }}
                          disabled={isPending}
                          className="rounded border border-rose-700 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-900/40 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
};

export default SessionsView;
