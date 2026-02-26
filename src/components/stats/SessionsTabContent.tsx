'use client';

import React from 'react';
import { formatNumber } from './helpers';
import type { SessionLensSummary } from './types';

interface SessionsTabContentProps {
  sessionLens?: SessionLensSummary;
}

const SessionsTabContent: React.FC<SessionsTabContentProps> = ({ sessionLens }) => (
  <>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-lg">
        <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Total Sessions
        </div>
        <div className="mt-2 text-3xl font-black text-white">
          {formatNumber(sessionLens?.totalSessions ?? 0)}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-lg">
        <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Channels
        </div>
        <div className="mt-2 text-3xl font-black text-white">
          {formatNumber(sessionLens?.byChannel.length ?? 0)}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-lg">
        <div className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Top Sessions
        </div>
        <div className="mt-2 text-3xl font-black text-white">
          {formatNumber(sessionLens?.topSessions.length ?? 0)}
        </div>
      </div>
    </div>

    {!sessionLens && (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
        Session lens data is currently unavailable.
      </div>
    )}

    {sessionLens && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
          <div className="mb-4 text-xs font-black tracking-widest text-white uppercase">
            Top Sessions
          </div>
          {sessionLens.topSessions.length === 0 ? (
            <div className="text-[10px] font-black text-zinc-600 uppercase">No sessions found.</div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-2 py-2 text-left text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                      Title
                    </th>
                    <th className="px-2 py-2 text-left text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                      Channel
                    </th>
                    <th className="px-2 py-2 text-left text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessionLens.topSessions.map((session) => (
                    <tr key={session.id} className="border-b border-zinc-800/50">
                      <td className="px-2 py-2.5 font-semibold text-zinc-300">
                        {session.title || session.id}
                      </td>
                      <td className="px-2 py-2.5 font-mono text-zinc-400">{session.channelType}</td>
                      <td className="px-2 py-2.5 font-mono text-zinc-500">
                        {new Date(session.updatedAt).toLocaleString('de-DE')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-lg">
          <div className="mb-4 text-xs font-black tracking-widest text-white uppercase">
            Channel Distribution
          </div>
          {sessionLens.byChannel.length === 0 ? (
            <div className="text-[10px] font-black text-zinc-600 uppercase">
              No channel data found.
            </div>
          ) : (
            <div className="space-y-2">
              {sessionLens.byChannel.map((entry) => {
                const width =
                  sessionLens.totalSessions > 0
                    ? (entry.count / sessionLens.totalSessions) * 100
                    : 0;
                return (
                  <div
                    key={entry.channelType}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3"
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold text-zinc-300">{entry.channelType}</span>
                      <span className="font-mono text-zinc-500">{formatNumber(entry.count)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    )}
  </>
);

export default SessionsTabContent;
