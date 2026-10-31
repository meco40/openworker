import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailClient, resetGmailClientState } from '@/server/master/connectors/gmail/client';

const originalMode = process.env.BETACLAW_MASTER_GMAIL_MODE;
const originalDetails = process.env.MASTER_GMAIL_FETCH_DETAILS;
let originalFetch: typeof fetch;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('GmailClient behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    originalFetch = globalThis.fetch;
    process.env.BETACLAW_MASTER_GMAIL_MODE = 'real';
    delete process.env.MASTER_GMAIL_FETCH_DETAILS;
    resetGmailClientState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    restoreEnv('BETACLAW_MASTER_GMAIL_MODE', originalMode);
    restoreEnv('MASTER_GMAIL_FETCH_DETAILS', originalDetails);
    resetGmailClientState();
  });

  it('returns metadata only for list and search when detail fetching is disabled', async () => {
    process.env.MASTER_GMAIL_FETCH_DETAILS = 'off';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url);
      return value.includes('&q=')
        ? jsonResponse({ messages: [{ id: 'search-1' }] })
        : jsonResponse({ messages: [{ id: 'list-1' }] });
    });
    const client = new GmailClient('oauth-token');

    const listed = await client.listMessages('scope-a');
    const searched = await client.searchMessages('scope-a', 'from:alice@example.com');

    expect(listed[0]).toMatchObject({ id: 'list-1', from: 'unknown', to: 'me', body: '' });
    expect(searched[0]).toMatchObject({
      id: 'search-1',
      subject: '(metadata unavailable)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('q=from%3Aalice%40example.com');
  });

  it('maps nested HTML, missing fields, invalid dates, and metadata-only messages', async () => {
    process.env.MASTER_GMAIL_FETCH_DETAILS = '   ';
    const html =
      '<style>.hidden{display:none}</style><script>ignored()</script><p>Hello   <b>world</b></p>';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url);
      if (value.includes('messages?maxResults=20')) {
        return jsonResponse({ messages: [{ id: 'html' }, { id: 'empty' }, { id: 'metadata' }] });
      }
      if (value.includes('messages/html?')) {
        return jsonResponse({
          id: 'html',
          internalDate: 'not-a-date',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [{ name: 'x-extra' }, { name: 'FROM', value: '  alice@example.com  ' }],
            parts: [
              { mimeType: 'application/pdf' },
              {
                mimeType: 'multipart/alternative',
                parts: [
                  {
                    mimeType: 'text/html',
                    body: { data: Buffer.from(html, 'utf8').toString('base64url') },
                  },
                ],
              },
            ],
          },
        });
      }
      if (value.includes('messages/empty?')) {
        return jsonResponse({
          id: 'empty',
          payload: {
            mimeType: '',
            headers: [
              { value: 'unlabeled' },
              { name: 'from', value: '' },
              { name: 'to' },
              { name: 'subject', value: '  ' },
            ],
            parts: [{ mimeType: 'application/pdf' }],
          },
        });
      }
      return jsonResponse({ id: 'metadata' });
    });

    const messages = await new GmailClient('oauth-token').listMessages('scope-a');

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      from: 'alice@example.com',
      to: 'me',
      subject: '(metadata unavailable)',
      body: 'Hello world',
      snippet: '',
    });
    expect(Number.isNaN(Date.parse(messages[0].createdAt))).toBe(false);
    expect(messages[1]).toMatchObject({
      from: 'unknown',
      to: 'me',
      subject: '(metadata unavailable)',
      body: '',
    });
    expect(messages[2]).toMatchObject({ body: '', snippet: '' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('creates drafts and sends RFC 2822 content through the real API', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'draft-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'sent-1' }));
    const client = new GmailClient('oauth-token');
    const draft = { to: 'alice@example.com', subject: 'Hello', body: 'Line one\nLine two' };

    const created = await client.createDraft(draft);
    const sent = await client.sendMessage('scope-a', draft);

    expect(created.id).toBe('draft-1');
    expect(sent.id).toBe('sent-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const draftInit = fetchMock.mock.calls[0]?.[1];
    const sendInit = fetchMock.mock.calls[1]?.[1];
    expect(draftInit?.headers).toMatchObject({ Authorization: 'Bearer oauth-token' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/drafts');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/messages/send');
    const draftPayload = JSON.parse(String(draftInit?.body)) as { message: { raw: string } };
    const sendPayload = JSON.parse(String(sendInit?.body)) as { raw: string };
    for (const raw of [draftPayload.message.raw, sendPayload.raw]) {
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');
      expect(decoded).toContain('To: alice@example.com');
      expect(decoded).toContain('Subject: Hello');
      expect(decoded).toContain('Line one\nLine two');
    }
  });

  it('fetches detailed messages for Gmail search results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const value = String(url);
      if (value.includes('messages?maxResults=20&q=')) {
        return jsonResponse({ messages: [{ id: 'search-detail' }] });
      }
      return jsonResponse({
        id: 'search-detail',
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from('matched body', 'utf8').toString('base64url') },
        },
      });
    });

    const results = await new GmailClient('oauth-token').searchMessages('scope-a', 'matched');

    expect(results[0]).toMatchObject({ id: 'search-detail', body: 'matched body' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates API errors for draft creation and requires an access token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('invalid credentials', { status: 401 }));
    const client = new GmailClient('oauth-token');

    await expect(
      client.createDraft({ to: 'alice@example.com', subject: 'Hello', body: 'Text' }),
    ).rejects.toThrow('Gmail API 401: invalid credentials');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(() => new GmailClient('')).toThrow('Missing Gmail access token.');
  });

  it.each([
    ['mock', 'oauth-token'],
    ['auto', 'mock:oauth-token'],
    ['auto', 'test-oauth-token'],
  ])('uses the local mailbox for %s mode and token %s', async (mode, token) => {
    process.env.BETACLAW_MASTER_GMAIL_MODE = mode;
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new GmailClient(token);

    await client.sendMessage('scope-a', {
      to: 'alice@example.com',
      subject: 'Local',
      body: 'Local message',
    });

    expect((await client.listMessages('scope-a'))[0]?.subject).toBe('Local');
    expect(await client.searchMessages('scope-a', 'local')).toHaveLength(1);
    await expect(client.searchMessages('missing-scope', 'not found')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty results when Gmail omits the messages collection', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({}));
    const client = new GmailClient('oauth-token');

    await expect(client.listMessages('scope-a')).resolves.toEqual([]);
    await expect(client.searchMessages('scope-a', 'hello')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
