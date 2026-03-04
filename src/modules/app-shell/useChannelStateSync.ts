import { useEffect } from 'react';

import { ChannelType, type CoupledChannel } from '@/shared/domain/types';
import { getGatewayClient } from '@/modules/gateway/ws-client';

interface ChannelStateApiItem {
  channel: string;
  status: string;
  peerName?: string | null;
  connectedAt?: string | null;
}

interface ChannelStateApiResponse {
  ok: boolean;
  channels?: ChannelStateApiItem[];
}

function toChannelType(channel: string): ChannelType | null {
  switch (channel) {
    case 'whatsapp':
      return ChannelType.WHATSAPP;
    case 'telegram':
      return ChannelType.TELEGRAM;
    case 'discord':
      return ChannelType.DISCORD;
    case 'imessage':
      return ChannelType.IMESSAGE;
    case 'slack':
      return ChannelType.SLACK;
    default:
      return null;
  }
}

function toUiStatus(status: string): CoupledChannel['status'] {
  if (status === 'connected') return 'connected';
  if (status === 'awaiting_code') return 'awaiting_code';
  if (status === 'pairing') return 'pairing';
  return 'idle';
}

export async function loadChannelState(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Record<string, Partial<CoupledChannel>>> {
  const response = await fetcher('/api/channels/state');
  const json = (await response.json()) as ChannelStateApiResponse;
  if (!response.ok || !json.ok || !Array.isArray(json.channels)) {
    return {};
  }

  const updates: Record<string, Partial<CoupledChannel>> = {};
  for (const channelState of json.channels) {
    const type = toChannelType(channelState.channel);
    if (!type) continue;
    updates[channelState.channel] = {
      type,
      status: toUiStatus(channelState.status),
      peerName: channelState.peerName || undefined,
      connectedAt: channelState.connectedAt || undefined,
    };
  }
  return updates;
}

interface UseChannelStateSyncArgs {
  enabled: boolean;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
}

export function useChannelStateSync({ enabled, onUpdateCoupling }: UseChannelStateSyncArgs): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;

    loadChannelState(fetch)
      .then((updates) => {
        if (disposed) return;
        Object.entries(updates).forEach(([id, update]) => onUpdateCoupling(id, update));
      })
      .catch(() => {
        // Keep local defaults when API is unavailable.
      });

    const client = getGatewayClient();
    client.connect();
    const unsubscribe = client.on('channels.status', (payload) => {
      const data = payload as {
        channel?: string;
        status?: string;
        peerName?: string;
        updatedAt?: string;
      };
      if (!data.channel) return;
      const type = toChannelType(data.channel);
      if (!type) return;

      onUpdateCoupling(data.channel, {
        type,
        status: toUiStatus(String(data.status || 'idle')),
        peerName: data.peerName || undefined,
        connectedAt: data.updatedAt || undefined,
      });
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [enabled, onUpdateCoupling]);
}
