'use client';

import React from 'react';
import type { GatewayClient } from './ws-client';
import { AgentV2GatewayClient } from './ws-agent-v2-client';

export function createGatewayClient() {
  return new AgentV2GatewayClient();
}

export function useGatewayClient() {
  const clientRef = React.useRef<GatewayClient | AgentV2GatewayClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = createGatewayClient();
  }

  React.useEffect(() => {
    const client = clientRef.current!;
    client.connect();
    return () => client.disconnect();
  }, []);

  return clientRef.current;
}
