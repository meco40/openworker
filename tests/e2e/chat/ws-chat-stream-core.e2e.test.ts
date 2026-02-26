import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

describe('ws chat stream core e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('streams with delta chunks and done frame', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const reset = await client.request('sessions.reset', { title: 'core-e2e' });
    const conversationId = (reset.payload as { conversationId: string }).conversationId;

    const frames = await client.stream('chat.stream', {
      conversationId,
      content: 'E2E_STREAM_CORE',
      personaId: 'persona-nexus',
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.done)).toBe(true);
    expect(frames.some((frame) => frame.delta.length > 0)).toBe(true);

    await client.close();
  });
});
