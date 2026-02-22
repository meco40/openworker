import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('ws chat abort e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('aborts an in-flight stream', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const reset = await client.request('sessions.reset', { title: 'abort-e2e' });
    const conversationId = (reset.payload as { conversationId: string }).conversationId;

    const streamPromise = client.stream('chat.stream', {
      conversationId,
      content: 'E2E_ABORT_WAIT',
      personaId: 'persona-nexus',
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const abortResponse = await client.request('chat.abort', { conversationId });

    expect(abortResponse.ok).toBe(true);
    expect((abortResponse.payload as { aborted: boolean }).aborted).toBe(true);

    const frames = await streamPromise;
    expect(frames.some((frame) => frame.done)).toBe(true);

    const history = await client.request('chat.history', { conversationId, limit: 20 });
    const messages = history.payload as Array<{ content?: string; role?: string }>;
    expect(messages.some((msg) => msg.role === 'agent' && String(msg.content || '').includes('aborted'))).toBe(true);

    await client.close();
  });
});
