import type { ChannelKey } from '@/server/channels/adapters/types';

export type ChannelBindingStatus =
  | 'idle'
  | 'pairing'
  | 'awaiting_code'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface ChannelBinding {
  userId: string;
  channel: ChannelKey;
  status: ChannelBindingStatus;
  externalPeerId: string | null;
  peerName: string | null;
  transport: string | null;
  metadata: string | null;
  personaId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertChannelBindingInput {
  userId: string;
  channel: ChannelKey;
  status: ChannelBindingStatus;
  externalPeerId?: string;
  peerName?: string;
  transport?: string;
  metadata?: Record<string, unknown> | null;
}
