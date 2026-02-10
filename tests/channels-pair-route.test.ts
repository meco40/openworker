import { describe, expect, it, vi } from 'vitest';
import { POST as pairPost } from '../app/api/channels/pair/route';

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/channels/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('channel pair route requests', () => {
  it('handles telegram pairing request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 123, username: 'claw_bot' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await pairPost(makeRequest({ channel: 'telegram', token: 'abc' }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.peerName).toContain('claw_bot');
    fetchMock.mockRestore();
  });

  it('handles discord pairing request', async () => {
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
    fetchMock.mockRestore();
  });

  it('handles imessage bridge health request', async () => {
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
    fetchMock.mockRestore();
  });
});
