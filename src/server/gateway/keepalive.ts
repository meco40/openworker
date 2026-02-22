import { getClientRegistry } from '@/server/gateway/client-registry';

/**
 * Runs one transport keepalive sweep:
 * - stale clients (missed pong) are terminated
 * - healthy clients receive a ping and are marked waiting-for-pong
 */
export function runGatewayKeepaliveSweep(): void {
  const registry = getClientRegistry();
  for (const client of registry.getAll()) {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) continue;

    if (client.isAlive === false) {
      try {
        socket.terminate();
      } catch {
        // ignore terminate errors
      }
      continue;
    }

    client.isAlive = false;
    try {
      socket.ping();
    } catch {
      // ignore ping errors; next sweep will terminate stale sockets
    }
  }
}
