// ─── Presence Method Handlers ────────────────────────────────
// RPC methods for online user presence.

import { registerMethod, type RespondFn } from '../method-router';
import type { GatewayClient } from '../client-registry';
import { getClientRegistry } from '../client-registry';

// ─── presence.list ───────────────────────────────────────────
// Return a list of currently connected user IDs.

registerMethod(
  'presence.list',
  (_params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const registry = getClientRegistry();
    const users: Array<{ userId: string; connections: number }> = [];
    const seen = new Set<string>();

    for (const c of registry.getAll()) {
      if (!seen.has(c.userId)) {
        seen.add(c.userId);
        users.push({
          userId: c.userId,
          connections: registry.getByUserId(c.userId).length,
        });
      }
    }
    respond(users);
  },
);

// ─── presence.whoami ─────────────────────────────────────────
// Return connection info for the calling client.

registerMethod(
  'presence.whoami',
  (_params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    respond({
      connId: client.connId,
      userId: client.userId,
      connectedAt: client.connectedAt,
      subscriptions: [...client.subscriptions],
    });
  },
);
