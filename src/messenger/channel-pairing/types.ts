import type { CoupledChannel } from '@/shared/domain/types';

export type ActiveTab = 'whatsapp' | 'telegram' | 'discord' | 'imessage' | 'slack';
export type BridgeTab = 'whatsapp' | 'imessage';

export type BridgeAccount = {
  accountId: string;
  pairingStatus?: string | null;
  peerName?: string | null;
  lastSeenAt?: string | null;
  allowFrom?: string[];
};

export type ChannelStateResponse = {
  ok?: boolean;
  channels?: Array<{
    channel?: string;
    accounts?: BridgeAccount[];
  }>;
};

export type WhatsAppAccountsResponse = {
  ok?: boolean;
  accounts?: BridgeAccount[];
};

export interface ChannelPairingProps {
  coupledChannels: Record<string, CoupledChannel>;
  onUpdateCoupling: (id: string, update: Partial<CoupledChannel>) => void;
  onSimulateIncoming?: (content: string, platform: import('@/shared/domain/types').ChannelType) => void;
}

