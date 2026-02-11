import { pairBridgeChannel } from './bridge';
import { pairDiscord } from './discord';
import { pairSlack } from './slack';
import { pairTelegram } from './telegram';
export { unpairChannel } from './unpair';
export type { UnpairChannelType } from './unpair';

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

export async function pairChannel(channel: PairChannelType, token = '') {
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
    return pairBridgeChannel(channel);
  }
  throw new Error(`Unsupported channel: ${channel}`);
}
