import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('ws persona stickiness e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('keeps initial persona binding for same conversation', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const reset = await client.request('sessions.reset', { title: 'persona-e2e' });
    const conversationId = (reset.payload as { conversationId: string }).conversationId;

    await client.stream('chat.stream', {
      conversationId,
      content: 'first persona bind',
      personaId: 'persona-nexus',
    });

    await expect(
      client.stream('chat.stream', {
        conversationId,
        content: 'try switch persona',
        personaId: 'persona-other',
      }),
    ).rejects.toThrow(/personaId mismatch/i);

    const conversations = await client.request('chat.conversations.list', { limit: 20 });
    const list = conversations.payload as Array<{ id: string; personaId?: string | null }>;
    const current = list.find((entry) => entry.id === conversationId);

    expect(current?.personaId).toBe('persona-nexus');
    await client.close();
  });
});
