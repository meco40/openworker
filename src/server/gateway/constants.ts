// ─── Gateway Constants ───────────────────────────────────────

/** Maximum WebSocket message payload size (512 KB) */
export const MAX_PAYLOAD_BYTES = 524_288;

/** Maximum buffered bytes before closing slow consumers (1.5 MB) */
export const MAX_BUFFERED_BYTES = 1_572_864;

/** Keepalive tick interval (30s) */
export const TICK_INTERVAL_MS = 30_000;

/** Handshake timeout — close if no hello within this window (10s) */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Maximum WebSocket connections per user (multi-tab) */
export const MAX_CONNECTIONS_PER_USER = 5;

/** Maximum RPC requests per minute per connection */
export const MAX_REQUESTS_PER_MINUTE = 60;

/** Gateway version identifier */
export const GATEWAY_VERSION = '1.0.0';
