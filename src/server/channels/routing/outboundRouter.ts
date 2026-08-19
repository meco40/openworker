import type { ChannelKey, OutboundDeliveryReceipt } from '@/server/channels/adapters/types';
import { getAdapter } from '@/server/channels/routing/adapterRegistry';

export interface OutboundRouteCommand {
  channel: ChannelKey;
  externalChatId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export async function routeOutboundWithReceipt(
  command: OutboundRouteCommand,
): Promise<OutboundDeliveryReceipt | null> {
  const adapter = getAdapter(command.channel);
  if (!adapter?.send) {
    return null;
  }
  const receipt = await adapter.send(command);
  return (
    receipt ?? {
      providerId: command.channel,
      deliveredAt: new Date().toISOString(),
    }
  );
}

export async function routeOutbound(command: OutboundRouteCommand): Promise<boolean> {
  return (await routeOutboundWithReceipt(command)) !== null;
}
