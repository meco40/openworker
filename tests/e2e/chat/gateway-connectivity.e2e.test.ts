import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('gateway connectivity e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('connects to /ws and receives responses', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const res = await client.request('chat.conversations.list', { limit: 1 });
    expect(res.type).toBe('res');
    expect(res.ok).toBe(true);
    await client.close();
  });
});
