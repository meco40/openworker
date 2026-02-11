import type { ChannelCapabilities, ChannelKey } from './types';

export const CHANNEL_CAPABILITIES: Record<ChannelKey, ChannelCapabilities> = {
  webchat: {
    supportsInbound: true,
    supportsOutbound: false,
    supportsPairing: false,
    supportsStreaming: true,
  },
  telegram: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  whatsapp: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  discord: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  imessage: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
  slack: {
    supportsInbound: true,
    supportsOutbound: true,
    supportsPairing: true,
    supportsStreaming: false,
  },
};

export function normalizeChannelKey(value: string): ChannelKey | null {
  const normalized = value.trim().toLowerCase();
  if (normalized in CHANNEL_CAPABILITIES) {
    return normalized as ChannelKey;
  }
  return null;
}
