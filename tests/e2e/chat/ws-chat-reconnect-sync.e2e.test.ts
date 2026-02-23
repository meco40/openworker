import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('ws reconnect sync e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('loads prior history after reconnect', async () => {
    const client1 = await createWsRpcClient(server.wsUrl());
    const reset = await client1.request('sessions.reset', { title: 'reconnect-e2e' });
    const conversationId = (reset.payload as { conversationId: string }).conversationId;

    await client1.stream('chat.stream', {
      conversationId,
      content: 'E2E_RECONNECT_MESSAGE',
      personaId: 'persona-nexus',
    });
    await client1.close();

    const client2 = await createWsRpcClient(server.wsUrl());
    const history = await client2.request('chat.history', { conversationId, limit: 20 });
    const messages = history.payload as Array<{ content?: string }>;

    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.some((msg) => String(msg.content || '').includes('E2E_RECONNECT_MESSAGE')),
    ).toBe(true);

    await client2.close();
  });
});
