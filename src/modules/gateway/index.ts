// ─── Gateway Module Index ────────────────────────────────────

export { GatewayClient, getGatewayClient, resetGatewayClient } from '@/modules/gateway/ws-client';
export type { ConnectionState } from '@/modules/gateway/ws-client';
export {
  useGatewayConnection,
  useGatewayEvent,
  useGatewayRequest,
} from '@/modules/gateway/useGatewayConnection';
