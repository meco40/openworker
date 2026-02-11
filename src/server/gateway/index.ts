// ─── Gateway Index ───────────────────────────────────────────
// Registers all RPC methods and re-exports the connection handler.
// Import this once on server startup.

// Register all method modules (side-effect imports)
import './methods/chat';
import './methods/worker';
import './methods/logs';
import './methods/presence';
import './methods/channels';

// Re-export for use in server.ts
export { handleConnection } from './connection-handler';
export { getClientRegistry } from './client-registry';
export { broadcast, broadcastToUser, broadcastToSubscribed } from './broadcast';
export { makeEvent } from './protocol';
export type { GatewayClient } from './client-registry';
