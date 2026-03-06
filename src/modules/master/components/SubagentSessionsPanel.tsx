import React from 'react';
import type { MasterSubagentSession } from '@/modules/master/types';

interface SubagentSessionsPanelProps {
  sessions: MasterSubagentSession[];
  runId?: string | null;
}

export function SubagentSessionsPanel({
  sessions,
  runId,
}: SubagentSessionsPanelProps): React.ReactElement {
  const visibleSessions = runId ? sessions.filter((session) => session.runId === runId) : sessions;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Subagent Sessions
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              Durable execution records for delegated work and worker recovery.
            </p>
          </div>
          <span className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-[10px] text-zinc-400">
            {visibleSessions.length} sessions
          </span>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {visibleSessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-500">
            No subagent sessions recorded.
          </div>
        ) : (
          visibleSessions.map((session) => (
            <article
              key={session.id}
              className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{session.title}</p>
                  <p className="mt-1 text-xs text-zinc-500">{session.prompt}</p>
                </div>
                <span className="rounded-full border border-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-400">
                  {session.status}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-400">
                {session.assignedTools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono"
                  >
                    {tool}
                  </span>
                ))}
              </div>
              {session.resultSummary && (
                <p className="mt-3 rounded-lg bg-zinc-900/70 px-3 py-2 text-xs text-zinc-300">
                  {session.resultSummary}
                </p>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
