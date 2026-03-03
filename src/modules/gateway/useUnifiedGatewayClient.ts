'use client';

import React from 'react';
import { GatewayClient } from './ws-client';
import { AgentV2GatewayClient } from './ws-agent-v2-client';
import type { MethodNamespace } from '@/server/gateway/method-router';

export function createGatewayClient(namespace: MethodNamespace = 'v1') {
  if (namespace === 'v2') {
    return new AgentV2GatewayClient();
  }
  return new GatewayClient({ protocol: 'v1' });
}

export function useGatewayClient(namespace: MethodNamespace = 'v1') {
  const clientRef = React.useRef<GatewayClient | AgentV2GatewayClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = createGatewayClient(namespace);
  }

  React.useEffect(() => {
    const client = clientRef.current!;
    client.connect();
    return () => client.disconnect();
  }, []);

  return clientRef.current;
}
