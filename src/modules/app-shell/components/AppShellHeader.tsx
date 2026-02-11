import React from 'react';
import type { ControlPlaneMetricsState } from '../../../../types';

interface AppShellHeaderProps {
  metricsState: ControlPlaneMetricsState;
}

function renderMetric(value: number | undefined): string {
  if (typeof value !== 'number') {
    return '--';
  }
  return value.toLocaleString('de-DE');
}

const AppShellHeader: React.FC<AppShellHeaderProps> = ({ metricsState }) => {
  const openTaskCount = metricsState.metrics?.pendingWorkerTasks;
  const vectorNodeCount = metricsState.metrics?.vectorNodeCount;

  return (
    <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-[#0c0c0c] z-10">
      <div className="flex items-center space-x-4">
        <h1 className="text-lg font-bold text-white tracking-tight">OpenClaw Gateway</h1>
        <div className="px-2 py-0.5 rounded border border-violet-500/30 bg-violet-500/5 text-[9px] font-black text-violet-400 uppercase tracking-widest">
          Active Bridge Node
        </div>
        {metricsState.stale && (
          <div className="px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-[9px] font-black text-amber-400 uppercase tracking-widest">
            Metrics Stale
          </div>
        )}
      </div>
      <div className="flex items-center space-x-6">
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Open Tasks</div>
          <div className="text-emerald-500 font-mono font-bold">{renderMetric(openTaskCount)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Vector Nodes</div>
          <div className="text-zinc-300 font-mono">{renderMetric(vectorNodeCount)}</div>
        </div>
      </div>
    </header>
  );
};

export default AppShellHeader;
