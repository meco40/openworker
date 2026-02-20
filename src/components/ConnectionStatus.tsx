'use client';

import React from 'react';
import { useGatewayConnection } from '@/modules/gateway';

const stateConfig = {
  connected: { color: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]', label: 'Live' },
  connecting: { color: 'bg-amber-500 animate-pulse', label: 'Connecting' },
  reconnecting: { color: 'bg-amber-500 animate-pulse', label: 'Reconnecting' },
  disconnected: { color: 'bg-red-500', label: 'Offline' },
  idle: { color: 'bg-zinc-600', label: 'Idle' },
} as const;

/**
 * Compact connection status indicator for the sidebar.
 * Shows a colored dot + label reflecting the WebSocket gateway state.
 */
const ConnectionStatus: React.FC = () => {
  const { state } = useGatewayConnection();
  const cfg = stateConfig[state] ?? stateConfig.idle;

  return (
    <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
      <span className="text-xs text-zinc-400">Gateway</span>
      <div className="flex items-center space-x-1.5">
        <span className="text-[10px] text-zinc-500">{cfg.label}</span>
        <span className={`h-2 w-2 rounded-full ${cfg.color}`} />
      </div>
    </div>
  );
};

export default ConnectionStatus;
