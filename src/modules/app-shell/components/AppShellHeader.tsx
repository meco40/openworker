import React from 'react';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';
import type { ConnectionState } from '@/modules/gateway/ws-client';

interface AppShellHeaderProps {
  metricsState: ControlPlaneMetricsState;
  gatewayConnectionState: ConnectionState;
}

function renderMetric(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
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

function resolveBridgeStatus(
  metricsState: ControlPlaneMetricsState,
  gatewayConnectionState: ConnectionState,
): {
  label: string;
  className: string;
} {
  if (gatewayConnectionState === 'connecting') {
    return {
      label: 'Connecting Gateway',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    };
  }
  if (gatewayConnectionState === 'reconnecting') {
    return {
      label: 'Reconnecting Gateway',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    };
  }
  if (gatewayConnectionState === 'disconnected') {
    return {
      label: 'Gateway Offline',
      className: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
    };
  }
  if (metricsState.stale || metricsState.error) {
    return {
      label: 'Bridge Degraded',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    };
  }
  if (metricsState.metrics) {
    return {
      label: 'Bridge Online',
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    };
  }
  if (metricsState.loading) {
    return {
      label: 'Checking Bridge',
      className: 'border-zinc-700 bg-zinc-800/50 text-zinc-400',
    };
  }
  return {
    label: 'Bridge Unavailable',
    className: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
  };
}

const AppShellHeader: React.FC<AppShellHeaderProps> = ({
  metricsState,
  gatewayConnectionState,
}) => {
  const activeSessions = metricsState.metrics?.activeWsSessions;
  const vectorNodeCount = metricsState.metrics?.vectorNodeCount;
  const ramUsageBytes = metricsState.metrics?.ramUsageBytes;
  const bridgeStatus = resolveBridgeStatus(metricsState, gatewayConnectionState);

  return (
    <header className="z-10 flex h-16 items-center justify-between border-b border-zinc-800 bg-[#0c0c0c] pr-3 pl-16 md:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        <h1 className="truncate text-sm font-bold tracking-tight text-white sm:text-lg">
          OpenClaw Gateway
        </h1>
        <div
          role="status"
          aria-live="polite"
          className={`shrink-0 rounded border px-2 py-0.5 text-[9px] font-black tracking-widest whitespace-nowrap uppercase ${bridgeStatus.className}`}
        >
          {bridgeStatus.label}
        </div>
      </div>
      <div className="hidden items-center space-x-6 md:flex">
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
