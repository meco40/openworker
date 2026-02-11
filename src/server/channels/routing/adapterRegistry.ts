import type { ChannelKey } from '../adapters/types';
import type { InboundEnvelope } from '../inbound/envelope';
import type { OutboundRouteCommand } from './outboundRouter';

export interface ChannelAdapter {
  channel: ChannelKey;
  send?: (command: OutboundRouteCommand) => Promise<void>;
  receive?: (envelope: InboundEnvelope) => Promise<void>;
}

const registry = new Map<ChannelKey, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  registry.set(adapter.channel, adapter);
}

export function getAdapter(channel: ChannelKey): ChannelAdapter | undefined {
  return registry.get(channel);
}

export function listAdapters(): ChannelAdapter[] {
  return [...registry.values()];
}

export function resetAdapterRegistryForTests(): void {
  registry.clear();
}
