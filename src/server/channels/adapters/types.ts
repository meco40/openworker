export type ChannelKey =
  | 'webchat'
  | 'agent_room'
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'imessage'
  | 'slack';

export interface ChannelCapabilities {
  supportsInbound: boolean;
  supportsOutbound: boolean;
  supportsPairing: boolean;
  supportsStreaming: boolean;
}
