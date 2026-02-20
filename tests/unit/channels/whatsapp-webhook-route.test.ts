import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../../../src/server/channels/credentials/credentialStore';
import {
  scopeBridgeExternalChatId,
  upsertBridgeAccount,
} from '../../../src/server/channels/pairing/bridgeAccounts';

type TestGlobals = typeof globalThis & {
  __credentialStore?: CredentialStore;
};

describe('whatsapp webhook route', () => {
  let store: CredentialStore;
  const previousMessagesDbPath = process.env.MESSAGES_DB_PATH;
  const previousAttachmentsDir = process.env.CHAT_ATTACHMENTS_DIR;
  const previousAllowFrom = process.env.WHATSAPP_ALLOW_FROM;

  beforeEach(() => {
    vi.resetModules();
    store = new CredentialStore(':memory:');
    (globalThis as TestGlobals).__credentialStore = store;
    process.env.MESSAGES_DB_PATH = ':memory:';
    process.env.CHAT_ATTACHMENTS_DIR = '.local/test-attachments';
    delete process.env.WHATSAPP_ALLOW_FROM;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as TestGlobals).__credentialStore = undefined;

    if (previousMessagesDbPath === undefined) delete process.env.MESSAGES_DB_PATH;
    else process.env.MESSAGES_DB_PATH = previousMessagesDbPath;
    if (previousAttachmentsDir === undefined) delete process.env.CHAT_ATTACHMENTS_DIR;
    else process.env.CHAT_ATTACHMENTS_DIR = previousAttachmentsDir;
    if (previousAllowFrom === undefined) delete process.env.WHATSAPP_ALLOW_FROM;
    else process.env.WHATSAPP_ALLOW_FROM = previousAllowFrom;
  });

  it('accepts account-scoped secrets and forwards scoped chat ids to message service', async () => {
    const handleInbound = vi.fn(async (..._args: unknown[]) => ({
      userMsg: {},
      agentMsg: {},
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({ handleInbound }),
    }));

    upsertBridgeAccount(
      'whatsapp',
      {
        accountId: 'sales',
        pairingStatus: 'connected',
        webhookSecret: 'sales-secret',
      },
      store,
    );

    const { POST } = await import('../../../app/api/channels/whatsapp/webhook/route');
    const request = new Request('http://localhost/api/channels/whatsapp/webhook?accountId=sales', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'sales-secret',
      },
      body: JSON.stringify({
        from: '+49123',
        body: 'Hello',
        messageId: 'msg-1',
        senderName: 'Alice',
      }),
    });

    const response = await POST(request);
    const json = (await response.json()) as { ok: boolean };
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);

    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(handleInbound.mock.calls[0][1]).toBe(scopeBridgeExternalChatId('sales', '+49123'));
    expect(handleInbound.mock.calls[0][2]).toBe('Hello');
    expect(handleInbound.mock.calls[0][6]).toBe('msg-1');
  });

  it('blocks senders outside allowlist and stores attachment metadata for allowed senders', async () => {
    const handleInbound = vi.fn(async (..._args: unknown[]) => ({
      userMsg: {},
      agentMsg: {},
    }));
    vi.doMock('../../../src/server/channels/messages/runtime', () => ({
      getMessageService: () => ({ handleInbound }),
    }));

    upsertBridgeAccount(
      'whatsapp',
      {
        accountId: 'default',
        pairingStatus: 'connected',
        webhookSecret: 'default-secret',
      },
      store,
    );

    const { POST } = await import('../../../app/api/channels/whatsapp/webhook/route');

    process.env.WHATSAPP_ALLOW_FROM = '+49999';
    const blockedRequest = new Request('http://localhost/api/channels/whatsapp/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'default-secret',
      },
      body: JSON.stringify({
        from: '+49123',
        body: 'blocked',
      }),
    });
    await POST(blockedRequest);
    expect(handleInbound).not.toHaveBeenCalled();

    process.env.WHATSAPP_ALLOW_FROM = '+49123';
    const bytes = Buffer.from('x');
    const allowedRequest = new Request('http://localhost/api/channels/whatsapp/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': 'default-secret',
      },
      body: JSON.stringify({
        from: '+49123',
        body: 'allowed',
        messageId: 'msg-2',
        attachment: {
          name: 'image.png',
          type: 'image/png',
          size: bytes.length,
          dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        },
      }),
    });

    await POST(allowedRequest);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    const attachments = handleInbound.mock.calls[0][7] as Array<{ storagePath?: string }> | undefined;
    expect(Array.isArray(attachments)).toBe(true);
    expect(attachments?.length).toBe(1);
    expect(String(attachments?.[0]?.storagePath || '')).not.toHaveLength(0);
  });
});
