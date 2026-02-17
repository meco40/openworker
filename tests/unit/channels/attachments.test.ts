import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMessageAttachmentMetadata,
  extractStoredAttachmentsFromMetadata,
  persistIncomingAttachment,
  readStoredAttachmentBuffer,
} from '../../../src/server/channels/messages/attachments';

describe('message attachments storage', () => {
  const previousDir = process.env.CHAT_ATTACHMENTS_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    process.env.CHAT_ATTACHMENTS_DIR = previousDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('persists a valid data-url attachment to disk and can read it back', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
    process.env.CHAT_ATTACHMENTS_DIR = tempDir;

    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9N5R8AAAAASUVORK5CYII=';

    const stored = persistIncomingAttachment({
      userId: 'u1',
      conversationId: 'c1',
      attachment: {
        name: 'pixel.png',
        type: 'image/png',
        size: Buffer.from(dataUrl.split(',')[1], 'base64').length,
        dataUrl,
      },
    });

    expect(stored.storagePath).toContain('/');
    const bytes = readStoredAttachmentBuffer(stored);
    expect(bytes.length).toBe(stored.size);
    expect(stored.sha256).toBeTruthy();

    const metadata = buildMessageAttachmentMetadata([stored]);
    const extracted = extractStoredAttachmentsFromMetadata(JSON.stringify(metadata));
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      name: stored.name,
      mimeType: stored.mimeType,
      size: stored.size,
      storagePath: stored.storagePath,
    });
  });

  it('rejects unsupported mime types', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-attachments-'));
    process.env.CHAT_ATTACHMENTS_DIR = tempDir;

    expect(() =>
      persistIncomingAttachment({
        userId: 'u1',
        conversationId: 'c1',
        attachment: {
          name: 'binary.bin',
          type: 'application/octet-stream',
          size: 4,
          dataUrl: 'data:application/octet-stream;base64,AAAAAA==',
        },
      }),
    ).toThrow(/not allowed/i);
  });
});
