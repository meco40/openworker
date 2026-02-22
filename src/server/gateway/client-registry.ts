// ─── Gateway Client Registry ─────────────────────────────────
// Tracks all connected WebSocket clients with user-scoped indexing.

import type { WebSocket } from 'ws';

// ─── Types ───────────────────────────────────────────────────

export interface GatewayClient {
  socket: WebSocket;
  connId: string;
  userId: string;
  connectedAt: number;
  /** Liveness flag for transport-level ping/pong keepalive. */
  isAlive?: boolean;
  subscriptions: Set<string>;
  requestCount: number;
  requestWindowStart: number;
  /** Per-connection sequence counter — each client gets its own contiguous sequence. */
  seq: number;
}

// ─── Registry ────────────────────────────────────────────────

class ClientRegistry {
  private clients = new Map<string, GatewayClient>();
  private userIndex = new Map<string, Set<string>>();

  register(client: GatewayClient): void {
    this.clients.set(client.connId, client);

    let userConns = this.userIndex.get(client.userId);
    if (!userConns) {
      userConns = new Set();
      this.userIndex.set(client.userId, userConns);
    }
    userConns.add(client.connId);
  }

  unregister(connId: string): GatewayClient | undefined {
    const client = this.clients.get(connId);
    if (!client) return undefined;

    this.clients.delete(connId);

    const userConns = this.userIndex.get(client.userId);
    if (userConns) {
      userConns.delete(connId);
      if (userConns.size === 0) {
        this.userIndex.delete(client.userId);
      }
    }

    return client;
  }

  get(connId: string): GatewayClient | undefined {
    return this.clients.get(connId);
  }

  getByUserId(userId: string): GatewayClient[] {
    const connIds = this.userIndex.get(userId);
    if (!connIds) return [];
    const result: GatewayClient[] = [];
    for (const id of connIds) {
      const c = this.clients.get(id);
      if (c) result.push(c);
    }
    return result;
  }

  getAll(): GatewayClient[] {
    return Array.from(this.clients.values());
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  getUserCount(): number {
    return this.userIndex.size;
  }

  getUserConnectionCount(userId: string): number {
    return this.userIndex.get(userId)?.size ?? 0;
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  var __gatewayClientRegistry: ClientRegistry | undefined;
}

export function getClientRegistry(): ClientRegistry {
  if (!globalThis.__gatewayClientRegistry) {
    globalThis.__gatewayClientRegistry = new ClientRegistry();
  }
  return globalThis.__gatewayClientRegistry;
}
