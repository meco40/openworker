import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailClient } from '@/server/master/connectors/gmail/client';

describe('gmail client real mode', () => {
  const originalMode = process.env.OPENCLAW_MASTER_GMAIL_MODE;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMode === undefined) {
      delete process.env.OPENCLAW_MASTER_GMAIL_MODE;
    } else {
      process.env.OPENCLAW_MASTER_GMAIL_MODE = originalMode;
    }
  });

  it('fetches detailed message metadata/body and tolerates per-message failures', async () => {
    process.env.OPENCLAW_MASTER_GMAIL_MODE = 'real';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: string | URL | Request) => {
        const value = String(url);
        if (value.includes('messages?maxResults=20')) {
          return new Response(JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (value.includes('messages/m1?format=full')) {
          return new Response(
            JSON.stringify({
              id: 'm1',
              snippet: 'hello snippet',
              internalDate: String(Date.now()),
              payload: {
                mimeType: 'multipart/alternative',
                headers: [
                  { name: 'From', value: 'alice@example.com' },
                  { name: 'To', value: 'me@example.com' },
                  { name: 'Subject', value: 'Hello' },
                ],
                parts: [
                  {
                    mimeType: 'text/plain',
                    body: { data: Buffer.from('hello body', 'utf8').toString('base64url') },
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (value.includes('messages/m2?format=full')) {
          return new Response('upstream error', { status: 500 });
        }
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

    const client = new GmailClient('real-access-token');
    const messages = await client.listMessages('scope:key');

    expect(fetchMock).toHaveBeenCalled();
    expect(messages).toHaveLength(2);
    expect(messages[0].subject).toBe('Hello');
    expect(messages[0].body).toContain('hello body');
    expect(messages[0].snippet).toBe('hello snippet');
    expect(messages[1].warnings?.length).toBeGreaterThan(0);
  });
});
