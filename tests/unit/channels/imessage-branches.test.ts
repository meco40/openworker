import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveriMessage } from '@/server/channels/outbound/imessage';

describe('deliveriMessage', () => {
  const originalEnv = process.env.IMESSAGE_BRIDGE_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IMESSAGE_BRIDGE_URL;
    } else {
      process.env.IMESSAGE_BRIDGE_URL = originalEnv;
    }
    globalThis.fetch = originalFetch;
  });

  it('returns early when IMESSAGE_BRIDGE_URL is not configured', async () => {
    delete process.env.IMESSAGE_BRIDGE_URL;
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await deliveriMessage('chat-1', 'Hello');

    expect(consoleErrorSpy).toHaveBeenCalledWith('IMESSAGE_BRIDGE_URL not configured.');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('posts to the bridge URL with chatGuid and message', async () => {
    process.env.IMESSAGE_BRIDGE_URL = 'https://bridge.example.com/';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deliveriMessage('chat-1', 'Hello');

    expect(fetchMock).toHaveBeenCalledWith('https://bridge.example.com/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatGuid: 'chat-1', message: 'Hello' }),
    });
  });

  it('strips trailing slash from bridge URL', async () => {
    process.env.IMESSAGE_BRIDGE_URL = 'https://bridge.example.com';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deliveriMessage('chat-1', 'Hello');

    expect(fetchMock).toHaveBeenCalledWith('https://bridge.example.com/send', expect.any(Object));
  });

  it('throws when bridge returns non-OK response', async () => {
    process.env.IMESSAGE_BRIDGE_URL = 'https://bridge.example.com/';
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(deliveriMessage('chat-1', 'Hello')).rejects.toThrow(
      'iMessage delivery failed with status 500',
    );
  });
});
