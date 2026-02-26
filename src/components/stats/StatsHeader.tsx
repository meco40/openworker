'use client';

import React from 'react';

interface StatsHeaderProps {
  onRefresh: () => void;
}

const StatsHeader: React.FC<StatsHeaderProps> = ({ onRefresh }) => (
  <div className="flex items-center justify-between">
    <div>
      <h2 className="text-lg font-black tracking-tight text-white">Usage Statistics</h2>
      <p className="mt-0.5 text-xs text-zinc-500">Token consumption & model analytics</p>
    </div>
    <button
      onClick={onRefresh}
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
);

export default StatsHeader;
