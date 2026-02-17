'use client';

import React from 'react';
import type { OperatorUsageSnapshot } from '../../../src/modules/profile/operatorProfileConfig';

interface UsagePanelProps {
  usage: OperatorUsageSnapshot;
  tokensToday: number;
  dailyTokenBudget: number;
}

export const UsagePanel: React.FC<UsagePanelProps> = ({
  usage,
  tokensToday,
  dailyTokenBudget,
}) => {
  return (
    <div className="relative space-y-8 overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
      <div className="absolute top-0 right-0 -mt-32 -mr-32 h-64 w-64 rounded-full bg-emerald-500/5 blur-[80px]" />
      <h3 className="relative text-xl font-black tracking-tight text-white uppercase">
        Local Usage & Capacity
      </h3>

      <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
          <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
            Workspace Slots
          </div>
          <div className="text-xl font-bold text-emerald-500">
            {usage.workspaceUsed} / {usage.workspaceTotal}
          </div>
        </div>
        <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
          <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
            Active Agents
          </div>
          <div className="text-xl font-bold text-white">{usage.activeAgents} Running</div>
        </div>
        <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
          <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
            Compute Budget
          </div>
          <div className="text-xl font-bold text-indigo-400">{usage.remainingBudgetPercent}% REM</div>
          <div className="text-[10px] text-zinc-500">
            {tokensToday.toLocaleString()} used / {dailyTokenBudget.toLocaleString()} daily
          </div>
        </div>
      </div>
    </div>
  );
};
