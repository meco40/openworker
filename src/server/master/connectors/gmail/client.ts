import crypto from 'node:crypto';
import type { GmailDraftInput, GmailMessage } from '@/server/master/connectors/gmail/types';

const mailbox = new Map<string, GmailMessage[]>();

export class GmailClient {
  constructor(private readonly accessToken: string) {
    if (!this.accessToken) {
      throw new Error('Missing Gmail access token.');
    }
  }

  listMessages(key: string): GmailMessage[] {
    return mailbox.get(key) || [];
  }

  searchMessages(key: string, query: string): GmailMessage[] {
    const normalized = query.toLowerCase();
    return this.listMessages(key).filter((entry) =>
      `${entry.subject}\n${entry.body}\n${entry.to}`.toLowerCase().includes(normalized),
    );
  }

  createDraft(input: GmailDraftInput): GmailMessage {
    return {
      id: `draft-${crypto.randomUUID()}`,
      from: 'me@gmail.local',
      to: input.to,
      subject: input.subject,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
  }

  sendMessage(key: string, input: GmailDraftInput): GmailMessage {
    const sent: GmailMessage = {
      id: `sent-${crypto.randomUUID()}`,
      from: 'me@gmail.local',
      to: input.to,
      subject: input.subject,
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    const items = mailbox.get(key) || [];
    items.push(sent);
    mailbox.set(key, items);
    return sent;
  }
}

export function resetGmailClientState(): void {
  mailbox.clear();
}
