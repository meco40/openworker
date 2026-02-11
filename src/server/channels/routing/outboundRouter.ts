import type { ChannelKey } from '../adapters/types';
import { getAdapter } from './adapterRegistry';

export interface OutboundRouteCommand {
  channel: ChannelKey;
  externalChatId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export async function routeOutbound(command: OutboundRouteCommand): Promise<boolean> {
  const adapter = getAdapter(command.channel);
  if (!adapter?.send) {
    return false;
  }
  await adapter.send(command);
  return true;
}
