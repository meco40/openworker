import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import {
  persistIncomingAttachment,
  resolveStoredAttachmentPath,
} from '@/server/channels/messages/attachments';

type MockUserContext = { userId: string; authenticated: boolean } | null;

function mockUserContext(context: MockUserContext): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('message delete route', () => {
  let repo: SqliteMessageRepository;
  let uploadRoot = '';

  beforeEach(() => {
    vi.resetModules();
    uploadRoot = path.resolve(
      '.local',
      `uploads.integration.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    process.env.CHAT_ATTACHMENTS_DIR = uploadRoot;

    repo = new SqliteMessageRepository(':memory:');
    (globalThis as { __messageRepository?: SqliteMessageRepository }).__messageRepository = repo;
    (globalThis as { __messageService?: unknown }).__messageService = undefined;

    mockUserContext({ userId: 'user-1', authenticated: true });
    vi.doMock('../../../src/server/gateway/broadcast', () => ({
      broadcastToUser: vi.fn(),
    }));
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

  it('hard-deletes one message from DB and removes its attachment file', async () => {
    const conversation = repo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'manual-user-1-1',
      title: 'Delete test',
      userId: 'user-1',
    });
    const attachment = persistIncomingAttachment({
      userId: 'user-1',
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
      content: 'Mit Datei',
      platform: ChannelType.WEBCHAT,
      metadata: { attachments: [attachment] },
    });

    const route = await import('../../../app/api/channels/messages/route');
    const response = await route.DELETE(
      new Request(
        `http://localhost/api/channels/messages?messageId=${encodeURIComponent(stored.id)}`,
        {
          method: 'DELETE',
        },
      ),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
    expect(repo.getMessage(stored.id, 'user-1')).toBeNull();
    expect(fs.existsSync(attachmentAbsPath)).toBe(false);
  });
});
