'use client';

import React from 'react';
import type { GatewayClient } from './ws-client';
import { AgentV2GatewayClient } from './ws-agent-v2-client';

export function createGatewayClient() {
  return new AgentV2GatewayClient();
}

export function useGatewayClient() {
  // Lazy state initialization creates exactly one client per component instance.
  const [client] = React.useState<GatewayClient | AgentV2GatewayClient>(createGatewayClient);

  React.useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return client;
}
