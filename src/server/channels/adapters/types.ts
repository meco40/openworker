export type ChannelKey = 'webchat' | 'telegram' | 'whatsapp' | 'discord' | 'imessage' | 'slack';

export interface ChannelCapabilities {
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsPairing: boolean;
  supportsStreaming: boolean;
}
