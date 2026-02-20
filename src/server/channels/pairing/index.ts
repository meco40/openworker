import { pairBridgeChannel } from '@/server/channels/pairing/bridge';
import { pairDiscord } from '@/server/channels/pairing/discord';
import { pairSlack } from '@/server/channels/pairing/slack';
import { pairTelegram } from '@/server/channels/pairing/telegram';
export { unpairChannel } from '@/server/channels/pairing/unpair';
export type { UnpairChannelType } from '@/server/channels/pairing/unpair';

export type PairChannelType = 'whatsapp' | 'telegram' | 'discord' | 'imessage' | 'slack';

export function isPairChannelType(value: string): value is PairChannelType {
  return (
    value === 'whatsapp' ||
    value === 'telegram' ||
    value === 'discord' ||
    value === 'imessage' ||
    value === 'slack'
  );
}

export async function pairChannel(channel: PairChannelType, token = '', accountId?: string) {
  if (channel === 'telegram') {
    return pairTelegram(token);
  }
  if (channel === 'discord') {
    return pairDiscord(token);
  }
  if (channel === 'slack') {
    return pairSlack(token);
  }
  if (channel === 'whatsapp' || channel === 'imessage') {
    return pairBridgeChannel(channel, accountId);
  }
  throw new Error(`Unsupported channel: ${channel}`);
}
