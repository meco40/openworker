import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { CredentialStore } from '@/server/channels/credentials/credentialStore';
import {
  persistIncomingAttachment,
  resolveStoredAttachmentPath,
} from '@/server/channels/messages/attachments';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import {
  beginTelegramCodePairing,
  confirmTelegramPairingCode,
  ensureTelegramPairingCode,
} from '@/server/channels/pairing/telegramCodePairing';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function makeTelegramWebhookRequest(chatId: number, text: string, messageThreadId?: number) {
  return new Request('http://localhost/api/channels/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': 'secret-1',
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 11,
        chat: {
          id: chatId,
          type: messageThreadId ? 'supergroup' : 'private',
          is_forum: !!messageThreadId,
        },
        from: { id: 22, username: 'alice' },
        text,
        ...(typeof messageThreadId === 'number' ? { message_thread_id: messageThreadId } : {}),
      },
    }),
  });
}

describe('telegram /chatdelete webhook integration', () => {
  let repo: SqliteMessageRepository;
  let uploadRoot = '';
  let telegramWebhookPost: (request: Request) => Promise<Response>;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    uploadRoot = path.resolve(
      getTestArtifactsRoot(),
      `uploads.telegram-delete.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    process.env.CHAT_ATTACHMENTS_DIR = uploadRoot;

    (globalThis as Record<string, unknown>).__credentialStore = new CredentialStore(':memory:');
    const store = (globalThis as Record<string, unknown>).__credentialStore as CredentialStore;
    store.setCredential('telegram', 'bot_token', 'bot-token');
    store.setCredential('telegram', 'webhook_secret', 'secret-1');

    repo = new SqliteMessageRepository(':memory:');
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository = repo;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;

    beginTelegramCodePairing();
    const issued = ensureTelegramPairingCode('123', new Date('2026-02-10T08:00:00.000Z'));
    if (issued.kind !== 'issued') {
      throw new Error('expected issued pairing code');
    }
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:01:00.000Z'));
    if (!confirmed.ok) {
      throw new Error('expected successful confirmation');
    }

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const route = await import('../../../app/api/channels/telegram/webhook/route');
    telegramWebhookPost = route.POST;
  });

  afterEach(() => {
    repo.close();
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository =
      undefined;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;
    delete process.env.CHAT_ATTACHMENTS_DIR;
    if (uploadRoot) {
      fs.rmSync(uploadRoot, { recursive: true, force: true });
      uploadRoot = '';
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('hard-deletes the latest message and does not persist /chatdelete itself', async () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.TELEGRAM,
      externalChatId: '123',
      title: 'Telegram delete',
    });
    const attachment = persistIncomingAttachment({
      userId: conversation.userId,
      conversationId: conversation.id,
      attachment: {
        name: 'note.txt',
        type: 'text/plain',
        size: 5,
        dataUrl: 'data:text/plain;base64,aGFsbG8=',
      },
    });
    const attachmentAbsPath = resolveStoredAttachmentPath(attachment.storagePath);
    expect(fs.existsSync(attachmentAbsPath)).toBe(true);

    const stored = repo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'Delete me',
      platform: ChannelType.TELEGRAM,
      metadata: { attachments: [attachment] },
    });

    const response = await telegramWebhookPost(makeTelegramWebhookRequest(123, '/chatdelete'));
    const payload = (await response.json()) as { ok: boolean };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(repo.getMessage(stored.id, conversation.userId)).toBeNull();
    expect(repo.listMessages(conversation.id, 20, undefined, conversation.userId)).toHaveLength(0);
    expect(fs.existsSync(attachmentAbsPath)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ method: 'POST' }),
    );
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const telegramPayload = JSON.parse(String(requestInit?.body || '{}')) as { text?: string };
    expect(telegramPayload.text).toBe('Last message deleted.');
  });

  it('deletes only within the current forum topic conversation', async () => {
    beginTelegramCodePairing();
    const issued = ensureTelegramPairingCode('-100123', new Date('2026-02-10T08:10:00.000Z'));
    if (issued.kind !== 'issued') {
      throw new Error('expected issued pairing code for topic chat');
    }
    const confirmed = confirmTelegramPairingCode(issued.code, new Date('2026-02-10T08:11:00.000Z'));
    if (!confirmed.ok) {
      throw new Error('expected successful confirmation for topic chat');
    }

    const baseConversation = repo.createConversation({
      channelType: ChannelType.TELEGRAM,
      externalChatId: '-100123',
      title: 'Base group',
    });
    const topicConversation = repo.createConversation({
      channelType: ChannelType.TELEGRAM,
      externalChatId: '-100123:topic:42',
      title: 'Topic 42',
    });

    const baseMessage = repo.saveMessage({
      conversationId: baseConversation.id,
      role: 'user',
      content: 'Keep base',
      platform: ChannelType.TELEGRAM,
    });
    const topicMessage = repo.saveMessage({
      conversationId: topicConversation.id,
      role: 'user',
      content: 'Delete topic',
      platform: ChannelType.TELEGRAM,
    });

    const response = await telegramWebhookPost(
      makeTelegramWebhookRequest(-100123, '/chatdelete', 42),
    );

    expect(response.status).toBe(200);
    expect(repo.getMessage(baseMessage.id, baseConversation.userId)).not.toBeNull();
    expect(repo.getMessage(topicMessage.id, topicConversation.userId)).toBeNull();
  });
});
