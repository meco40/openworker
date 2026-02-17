'use client';

import React from 'react';

interface LogsHeaderProps {
  isConnected: boolean;
  totalCount: number;
}

export const LogsHeader: React.FC<LogsHeaderProps> = ({ isConnected, totalCount }) => {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="flex items-center space-x-3 text-xl font-bold tracking-tight text-white">
          <span>System Logs</span>
          <span
            className={`inline-flex items-center space-x-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
              isConnected
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-500'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'animate-pulse bg-emerald-500' : 'bg-zinc-600'}`}
            />
            <span>{isConnected ? 'LIVE' : 'OFFLINE'}</span>
          </span>
        </h2>
        <p className="mt-0.5 text-sm text-zinc-500">
          Real-time telemetry and bridge activity stream.
          {totalCount > 0 && (
            <span className="ml-2 text-zinc-600">{totalCount.toLocaleString()} total entries</span>
          )}
        </p>
      </div>
    </div>
  );
};
