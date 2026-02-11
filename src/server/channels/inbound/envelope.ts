import type { ChannelKey } from '../adapters/types';

export interface InboundEnvelope {
  channel: ChannelKey;
  externalChatId: string;
  externalMessageId: string | null;
  senderName: string | null;
  content: string;
  receivedAt: string;
  raw: unknown;
}
