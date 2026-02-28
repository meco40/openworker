import crypto from 'node:crypto';
import type { GmailDraftInput, GmailMessage } from '@/server/master/connectors/gmail/types';

const mailbox = new Map<string, GmailMessage[]>();
const MAX_BODY_CHARS = 4000;

function isMockMode(accessToken: string): boolean {
  const mode = String(process.env.OPENCLAW_MASTER_GMAIL_MODE || 'auto').toLowerCase();
  if (mode === 'mock') return true;
  if (mode === 'real') return false;
  if (accessToken.startsWith('mock:')) return true;
  if (accessToken === 'access-token') return true;
  return accessToken.startsWith('test-');
}

function isDetailFetchEnabled(): boolean {
  const normalized = String(process.env.MASTER_GMAIL_FETCH_DETAILS ?? '1')
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
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

function decodeBase64Url(value: string): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface GmailHeaderRow {
  name?: string;
  value?: string;
}

interface GmailPayload {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  headers?: GmailHeaderRow[];
  parts?: GmailPayload[];
}

interface GmailMessageApi {
  id: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
}

function headerValue(headers: GmailHeaderRow[] | undefined, name: string): string {
  const row = (headers || []).find((entry) => String(entry.name || '').toLowerCase() === name);
  return String(row?.value || '').trim();
}

function firstBodyText(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  const mime = String(payload.mimeType || '').toLowerCase();
  const bodyData = decodeBase64Url(String(payload.body?.data || ''));
  if (mime.includes('text/plain') && bodyData) {
    return bodyData;
  }
  if (mime.includes('text/html') && bodyData) {
    return stripHtml(bodyData);
  }
  for (const part of payload.parts || []) {
    const nested = firstBodyText(part);
    if (nested) return nested;
  }
  return '';
}

function mapGmailApiMessageToDomain(input: GmailMessageApi, warning?: string): GmailMessage {
  const headers = input.payload?.headers || [];
  const bodyText = firstBodyText(input.payload).slice(0, MAX_BODY_CHARS);
  const parsedDate = Number(input.internalDate || 0);
  return {
    id: input.id,
    from: headerValue(headers, 'from') || 'unknown',
    to: headerValue(headers, 'to') || 'me',
    subject: headerValue(headers, 'subject') || '(metadata unavailable)',
    body: bodyText,
    bodyText,
    snippet: String(input.snippet || '').trim(),
    warnings: warning ? [warning] : undefined,
    createdAt:
      Number.isFinite(parsedDate) && parsedDate > 0
        ? new Date(parsedDate).toISOString()
        : new Date().toISOString(),
  };
}

async function fetchMessageDetails(
  accessToken: string,
  id: string,
): Promise<{ message: GmailMessage; warning?: string }> {
  try {
    const detail = await gmailApiFetch<GmailMessageApi>(accessToken, `messages/${id}?format=full`);
    return { message: mapGmailApiMessageToDomain(detail) };
  } catch {
    return {
      message: {
        id,
        from: 'unknown',
        to: 'me',
        subject: '(metadata unavailable)',
        body: '',
        bodyText: '',
        snippet: '',
        warnings: ['Failed to fetch full message payload.'],
        createdAt: new Date().toISOString(),
      },
      warning: id,
    };
  }
}

function mapMetadataMessage(id: string): GmailMessage {
  return {
    id,
    from: 'unknown',
    to: 'me',
    subject: '(metadata unavailable)',
    body: '',
    bodyText: '',
    snippet: '',
    createdAt: new Date().toISOString(),
  };
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
    if (!isDetailFetchEnabled()) {
      return messages.map((entry) => mapMetadataMessage(entry.id));
    }
    const results = await Promise.all(
      messages.map((entry) => fetchMessageDetails(this.accessToken, entry.id)),
    );
    return results.map((entry) => entry.message);
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
    if (!isDetailFetchEnabled()) {
      return messages.map((entry) => mapMetadataMessage(entry.id));
    }
    const results = await Promise.all(
      messages.map((entry) => fetchMessageDetails(this.accessToken, entry.id)),
    );
    return results.map((entry) => ({
      ...entry.message,
      subject: entry.message.subject || `Search match for: ${query}`,
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
