import type { InboundEnvelope } from '../inbound/envelope';
import { getAdapter } from './adapterRegistry';

export async function routeInbound(
  envelope: InboundEnvelope,
  fallbackHandler?: (envelope: InboundEnvelope) => Promise<void>,
): Promise<boolean> {
  const adapter = getAdapter(envelope.channel);
  if (adapter?.receive) {
    await adapter.receive(envelope);
    return true;
  }
  if (fallbackHandler) {
    await fallbackHandler(envelope);
    return true;
  }
  return false;
}
