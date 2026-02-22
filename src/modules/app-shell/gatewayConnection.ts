import { getGatewayClient } from '@/modules/gateway/ws-client';

export async function waitForGatewayConnected(timeoutMs = 5_000): Promise<void> {
  const client = getGatewayClient();
  if (client.state === 'connected') return;

  client.connect();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('WebSocket not connected.'));
    }, timeoutMs);

    const unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });

    if (client.state === 'connected') {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}
