import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopeBridgeExternalChatId } from '../../../src/server/channels/pairing/bridgeAccounts';
import { deliverWhatsApp } from '../../../src/server/channels/outbound/whatsapp';

describe('whatsapp outbound delivery', () => {
  const previousBridgeUrl = process.env.WHATSAPP_BRIDGE_URL;

  beforeEach(() => {
    process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.local';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousBridgeUrl === undefined) {
      delete process.env.WHATSAPP_BRIDGE_URL;
    } else {
      process.env.WHATSAPP_BRIDGE_URL = previousBridgeUrl;
    }
  });

  it('uses account-aware headers and payload for scoped conversation ids', async () => {
    const scopedChatId = scopeBridgeExternalChatId('sales', '491234@s.whatsapp.net');
    await deliverWhatsApp(scopedChatId, 'hello');

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(String((options as RequestInit).body || '{}')) as {
      to?: string;
      accountId?: string;
      message?: string;
    };
    expect(body.to).toBe('491234@s.whatsapp.net');
    expect(body.accountId).toBe('sales');
    expect(body.message).toBe('hello');
    expect((options as RequestInit).headers).toMatchObject({
      'x-openclaw-account-id': 'sales',
    });
  });
});
