'use client';

import React from 'react';
import type { ConnectionState } from '@/modules/gateway/ws-client';

const stateConfig = {
  connected: { color: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]', label: 'Live' },
  connecting: { color: 'bg-amber-500 animate-pulse', label: 'Connecting' },
  reconnecting: { color: 'bg-amber-500 animate-pulse', label: 'Reconnecting' },
  disconnected: { color: 'bg-red-500', label: 'Offline' },
} as const;

/**
 * Compact connection status indicator for the sidebar.
 * Shows a colored dot + label reflecting the WebSocket gateway state.
 */
interface ConnectionStatusProps {
  state: ConnectionState;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({ state }) => {
  const cfg = stateConfig[state] ?? stateConfig.disconnected;

  return (
    <output
      aria-live="polite"
      className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2"
    >
      <span className="text-xs text-zinc-400">Gateway</span>
      <span className="flex items-center space-x-1.5">
        <span className="text-[10px] text-zinc-500">{cfg.label}</span>
        <span className={`h-2 w-2 rounded-full ${cfg.color}`} />
      </span>
    </output>
  );
};

export default ConnectionStatus;
