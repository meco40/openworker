// ─── Gateway Module Index ────────────────────────────────────

export { GatewayClient, getGatewayClient, resetGatewayClient } from './ws-client';
export type { ConnectionState } from './ws-client';
export { useGatewayConnection, useGatewayEvent, useGatewayRequest } from './useGatewayConnection';
