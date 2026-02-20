import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestGlobals = typeof globalThis & {
  __credentialStore?: unknown;
  __messageRepository?: unknown;
  __messageService?: unknown;
  __pollingResumeChecked?: boolean;
  __telegramPollingTimer?: ReturnType<typeof setTimeout>;
  __telegramPollingActive?: boolean;
};

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/channels/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('channel pair route requests', () => {
  let previousMessagesDbPath: string | undefined;
  let previousAppUrl: string | undefined;
  let previousWhatsAppBridgeUrl: string | undefined;
  let previousIMessageBridgeUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();

    previousMessagesDbPath = process.env.MESSAGES_DB_PATH;
    previousAppUrl = process.env.APP_URL;
    previousWhatsAppBridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
    previousIMessageBridgeUrl = process.env.IMESSAGE_BRIDGE_URL;
    process.env.MESSAGES_DB_PATH = ':memory:';

    const globals = globalThis as TestGlobals;
    if (globals.__telegramPollingTimer) {
      clearTimeout(globals.__telegramPollingTimer);
    }
    globals.__credentialStore = undefined;
    globals.__messageRepository = undefined;
    globals.__messageService = undefined;
    globals.__pollingResumeChecked = undefined;
    globals.__telegramPollingTimer = undefined;
    globals.__telegramPollingActive = undefined;
  });

  afterEach(() => {
    process.env.MESSAGES_DB_PATH = previousMessagesDbPath;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousWhatsAppBridgeUrl === undefined) delete process.env.WHATSAPP_BRIDGE_URL;
    else process.env.WHATSAPP_BRIDGE_URL = previousWhatsAppBridgeUrl;
    if (previousIMessageBridgeUrl === undefined) delete process.env.IMESSAGE_BRIDGE_URL;
    else process.env.IMESSAGE_BRIDGE_URL = previousIMessageBridgeUrl;
    const globals = globalThis as TestGlobals;
    if (globals.__telegramPollingTimer) {
      clearTimeout(globals.__telegramPollingTimer);
    }
    globals.__credentialStore = undefined;
    globals.__messageRepository = undefined;
    globals.__messageService = undefined;
    globals.__pollingResumeChecked = undefined;
    globals.__telegramPollingTimer = undefined;
    globals.__telegramPollingActive = undefined;
    vi.restoreAllMocks();
  });

  it('handles telegram pairing request', async () => {
    const { POST: pairPost } = await import('../app/api/channels/pair/route');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 123, username: 'claw_bot' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const response = await pairPost(makeRequest({ channel: 'telegram', token: 'abc' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('awaiting_code');
    expect(json.transport).toBe('polling');
    expect(json.peerName).toContain('claw_bot');
    fetchMock.mockRestore();
  });

  it('handles discord pairing request', async () => {
    const { POST: pairPost } = await import('../app/api/channels/pair/route');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: '1',
          username: 'claw-discord',
          discriminator: '0',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await pairPost(makeRequest({ channel: 'discord', token: 'abc' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(String(json.peerName)).toContain('claw-discord');
    fetchMock.mockRestore();
  });

  it('handles whatsapp bridge health request', async () => {
    const { POST: pairPost } = await import('../app/api/channels/pair/route');
    const { getCredentialStore } = await import('../src/server/channels/credentials');
    process.env.WHATSAPP_BRIDGE_URL = 'http://localhost:8787';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ peerName: 'wa-bridge' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await pairPost(makeRequest({ channel: 'whatsapp' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.peerName).toBe('wa-bridge');
    expect(getCredentialStore().getCredential('whatsapp', 'pairing_status')).toBe('connected');
    fetchMock.mockRestore();
  });

  it('pairs whatsapp account-specific bridge credentials', async () => {
    const { POST: pairPost } = await import('../app/api/channels/pair/route');
    const { getCredentialStore } = await import('../src/server/channels/credentials');
    process.env.WHATSAPP_BRIDGE_URL = 'http://localhost:8787';
    process.env.APP_URL = 'http://localhost:3000';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ peerName: 'wa-sales' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const response = await pairPost(makeRequest({ channel: 'whatsapp', accountId: 'sales' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.accountId).toBe('sales');
    expect(getCredentialStore().getCredential('whatsapp', 'account.sales.pairing_status')).toBe(
      'connected',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/webhook');
    fetchMock.mockRestore();
  });

  it('handles imessage bridge health request', async () => {
    const { POST: pairPost } = await import('../app/api/channels/pair/route');
    const { getCredentialStore } = await import('../src/server/channels/credentials');
    process.env.IMESSAGE_BRIDGE_URL = 'http://localhost:8788';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ peerName: 'imessage-bridge' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await pairPost(makeRequest({ channel: 'imessage' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.peerName).toBe('imessage-bridge');
    expect(getCredentialStore().getCredential('imessage', 'pairing_status')).toBe('connected');
    fetchMock.mockRestore();
  });
});
