import crypto from 'node:crypto';
import type { GmailDraftInput, GmailMessage } from '@/server/master/connectors/gmail/types';

const mailbox = new Map<string, GmailMessage[]>();

function isMockMode(accessToken: string): boolean {
  const mode = String(process.env.OPENCLAW_MASTER_GMAIL_MODE || 'auto').toLowerCase();
  if (mode === 'mock') return true;
  if (mode === 'real') return false;
  if (accessToken.startsWith('mock:')) return true;
  if (accessToken === 'access-token') return true;
  return accessToken.startsWith('test-');
}

function toRawMime(draft: GmailDraftInput): string {
  const payload = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    draft.body,
  ].join('\r\n');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

async function gmailApiFetch<T>(
  accessToken: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

function fromMockDraft(prefix: string, input: GmailDraftInput): GmailMessage {
  return {
    id: `${prefix}-${crypto.randomUUID()}`,
    from: 'me@gmail.local',
    to: input.to,
    subject: input.subject,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
}

export class GmailClient {
  private readonly mock: boolean;

  constructor(private readonly accessToken: string) {
    if (!this.accessToken) {
      throw new Error('Missing Gmail access token.');
    }
    this.mock = isMockMode(accessToken);
  }

  async listMessages(key: string): Promise<GmailMessage[]> {
    if (this.mock) {
      return mailbox.get(key) || [];
    }
    const data = await gmailApiFetch<{ messages?: Array<{ id: string }> }>(
      this.accessToken,
      'messages?maxResults=20',
    );
    const messages = data.messages || [];
    return messages.map((entry) => ({
      id: entry.id,
      from: 'unknown',
      to: 'me',
      subject: '(metadata unavailable)',
      body: '',
      createdAt: new Date().toISOString(),
    }));
  }

  async searchMessages(key: string, query: string): Promise<GmailMessage[]> {
    if (this.mock) {
      const normalized = query.toLowerCase();
      return (mailbox.get(key) || []).filter((entry) =>
        `${entry.subject}\n${entry.body}\n${entry.to}`.toLowerCase().includes(normalized),
      );
    }
    const data = await gmailApiFetch<{ messages?: Array<{ id: string }> }>(
      this.accessToken,
      `messages?maxResults=20&q=${encodeURIComponent(query)}`,
    );
    const messages = data.messages || [];
    return messages.map((entry) => ({
      id: entry.id,
      from: 'unknown',
      to: 'me',
      subject: `Search match for: ${query}`,
      body: '',
      createdAt: new Date().toISOString(),
    }));
  }

  async createDraft(input: GmailDraftInput): Promise<GmailMessage> {
    if (this.mock) {
      return fromMockDraft('draft', input);
    }
    const payload = {
      message: {
        raw: toRawMime(input),
      },
    };
    const data = await gmailApiFetch<{ id: string }>(this.accessToken, 'drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return {
      id: data.id,
      from: 'me',
      to: input.to,
      subject: input.subject,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
  }

  async sendMessage(key: string, input: GmailDraftInput): Promise<GmailMessage> {
    if (this.mock) {
      const sent = fromMockDraft('sent', input);
      const items = mailbox.get(key) || [];
      items.push(sent);
      mailbox.set(key, items);
      return sent;
    }
    const payload = {
      raw: toRawMime(input),
    };
    const data = await gmailApiFetch<{ id: string }>(this.accessToken, 'messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return {
      id: data.id,
      from: 'me',
      to: input.to,
      subject: input.subject,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
  }
}

export function resetGmailClientState(): void {
  mailbox.clear();
}
