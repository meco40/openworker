import React from 'react';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';

interface AppShellHeaderProps {
  metricsState: ControlPlaneMetricsState;
}

function renderMetric(value: number | undefined): string {
  if (typeof value !== 'number') {
    return '--';
  }
  return value.toLocaleString('de-DE');
}

function renderRamUsageMetric(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '--';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const fractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ${units[unitIndex]}`;
}

const AppShellHeader: React.FC<AppShellHeaderProps> = ({ metricsState }) => {
  const activeSessions = metricsState.metrics?.activeWsSessions;
  const vectorNodeCount = metricsState.metrics?.vectorNodeCount;
  const ramUsageBytes = metricsState.metrics?.ramUsageBytes;

  return (
    <header className="z-10 flex h-16 items-center justify-between border-b border-zinc-800 bg-[#0c0c0c] px-6">
      <div className="flex items-center space-x-4">
        <h1 className="text-lg font-bold tracking-tight text-white">OpenClaw Gateway</h1>
        <div className="rounded border border-violet-500/30 bg-violet-500/5 px-2 py-0.5 text-[9px] font-black tracking-widest text-violet-400 uppercase">
          Active Bridge Node
        </div>
        {metricsState.stale && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-black tracking-widest text-amber-400 uppercase">
            Metrics Stale
          </div>
        )}
      </div>
      <div className="flex items-center space-x-6">
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Active Sessions</div>
          <div className="font-mono font-bold text-emerald-500">{renderMetric(activeSessions)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Vector Nodes</div>
          <div className="font-mono text-zinc-300">{renderMetric(vectorNodeCount)}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">RAM Usage</div>
          <div className="font-mono text-zinc-300">{renderRamUsageMetric(ramUsageBytes)}</div>
        </div>
      </div>
    </header>
  );
};

export default AppShellHeader;
