import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WsClient from 'ws';
import { ManagedServer } from '../_shared/managedServer';
import { createWsRpcClient } from '../_shared/wsRpcClient';

async function expectUpgradeRejected(url: string): Promise<number> {
  const socket = new WsClient(url);

  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out waiting for upgrade rejection: ${url}`));
    }, 15_000);

    socket.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      const statusCode = res.statusCode ?? 0;
      res.resume();
      resolve(statusCode);
    });

    socket.once('open', () => {
      clearTimeout(timer);
      reject(new Error(`Expected upgrade rejection but socket opened: ${url}`));
    });

    socket.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/Unexpected server response: (\d{3})/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
        return;
      }
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe('gateway connectivity e2e', () => {
  const server = new ManagedServer();

  beforeAll(async () => {
    await server.start();
  }, 180_000);

  afterAll(async () => {
    await server.stop();
  });

  it('connects to /ws?protocol=v2 and receives responses', async () => {
    const client = await createWsRpcClient(server.wsUrl());
    const res = await client.request('chat.conversations.list', { limit: 1 });
    expect(res.type).toBe('res');
    expect(res.ok).toBe(true);
    await client.close();
  });

  it('rejects upgrade when protocol query is missing', async () => {
    const status = await expectUpgradeRejected(server.wsBaseUrl());
    expect(status).toBe(400);
  });

  it('rejects upgrade for protocol=v1', async () => {
    const status = await expectUpgradeRejected(`${server.wsBaseUrl()}?protocol=v1`);
    expect(status).toBe(400);
  });

  it('rejects upgrade for protocol=invalid', async () => {
    const status = await expectUpgradeRejected(`${server.wsBaseUrl()}?protocol=invalid`);
    expect(status).toBe(400);
  });
});
