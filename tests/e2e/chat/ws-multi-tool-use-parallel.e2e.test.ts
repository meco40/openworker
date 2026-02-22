import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('ws multi_tool_use.parallel e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('executes multi_tool_use.parallel through chat tool loop', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const reset = await client.request('sessions.reset', { title: 'parallel-e2e' });
    const conversationId = (reset.payload as { conversationId: string }).conversationId;

    await client.stream('chat.stream', {
      conversationId,
      content: 'parallel-check',
      personaId: 'persona-nexus',
    });

    const history = await client.request('chat.history', { conversationId, limit: 20 });
    const messages = history.payload as Array<{ role?: string; content?: string }>;
    expect(messages.some((msg) => msg.role === 'agent' && String(msg.content || '').includes('parallel'))).toBe(true);

    await client.close();
  });
});
