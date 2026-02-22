import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMessageAttachmentMetadata,
  extractStoredAttachmentsFromMetadata,
  persistIncomingAttachment,
  readStoredAttachmentBuffer,
  resolveStoredAttachmentPath,
} from '@/server/channels/messages/attachments';

describe('message attachments storage', () => {
  const previousDir = process.env.CHAT_ATTACHMENTS_DIR;
  let tempDir: string | null = null;
  const cleanupPaths: string[] = [];

  afterEach(() => {
    process.env.CHAT_ATTACHMENTS_DIR = previousDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    for (const filePath of cleanupPaths.splice(0, cleanupPaths.length)) {
      try {
        fs.rmSync(filePath, { recursive: true, force: true });
      } catch {
        // noop
      }
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

  it('stores persona-scoped attachments under .local/personas/<slug>/uploads', () => {
    const dataUrl = 'data:text/plain;base64,aGVsbG8=';

    const stored = persistIncomingAttachment({
      userId: 'u1',
      conversationId: 'c1',
      personaSlug: 'nata_girl',
      attachment: {
        name: 'note.txt',
        type: 'text/plain',
        size: Buffer.from(dataUrl.split(',')[1], 'base64').length,
        dataUrl,
      },
    });

    expect(stored.storagePath.startsWith('personas/nata_girl/uploads/docs/')).toBe(true);
    const absolutePath = resolveStoredAttachmentPath(stored.storagePath);
    cleanupPaths.push(path.resolve('.local/personas/nata_girl'));
    expect(fs.existsSync(absolutePath)).toBe(true);
  });

  it('routes persona image attachments into uploads/images', () => {
    const dataUrl =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8QEA8QEA8PDw8QDw8QEA8QFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDQ0NDg0NDisZFRkrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrK//AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAABAgAD/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEh/9oADAMBAAIQAxAAAAHiiAH/xAAWEAEBAQAAAAAAAAAAAAAAAAAAARH/2gAIAQEAAT8Aqf/EABYRAQEBAAAAAAAAAAAAAAAAAAABEf/aAAgBAgEBPwCn/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEh/9oACAEDAQE/AKf/2Q==';

    const stored = persistIncomingAttachment({
      userId: 'u1',
      conversationId: 'c1',
      personaSlug: 'nata_girl',
      attachment: {
        name: 'photo.jpg',
        type: 'image/jpeg',
        size: Buffer.from(dataUrl.split(',')[1], 'base64').length,
        dataUrl,
      },
    });

    expect(stored.storagePath.startsWith('personas/nata_girl/uploads/images/')).toBe(true);
    cleanupPaths.push(path.resolve('.local/personas/nata_girl'));
  });
});
