import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractTelegramInboundMedia,
  resolveTelegramInboundText,
} from '../../../src/server/channels/telegram/media';

describe('telegram media helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers text over caption and summary', () => {
    const content = resolveTelegramInboundText(
      { text: 'hello', caption: 'caption ignored' },
      '[Photo]',
    );
    expect(content).toBe('hello');
  });

  it('uses caption when text is missing', () => {
    const content = resolveTelegramInboundText({ caption: 'this is a caption' }, '[Photo]');
    expect(content).toBe('this is a caption');
  });

  it('falls back to media summary when text and caption are missing', () => {
    const content = resolveTelegramInboundText({}, '[Sticker]');
    expect(content).toBe('[Sticker]');
  });

  it('returns sticker summary even without bot token', async () => {
    const result = await extractTelegramInboundMedia({
      message: {
        sticker: {
          file_id: 'sticker-1',
          file_unique_id: 'uniq-1',
          emoji: '🙂',
        },
      },
      userId: 'u1',
      conversationId: 'c1',
      botToken: null,
    });

    expect(result.attachments).toHaveLength(0);
    expect(result.summaryText).toContain('[Sticker');
  });

  it('downloads and persists photo attachment when token is configured', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-media-'));
    process.env.CHAT_ATTACHMENTS_DIR = tmpRoot;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/1.jpg' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('abc123'), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractTelegramInboundMedia({
      message: {
        photo: [{ file_id: 'photo-1', file_size: 6 }],
      },
      userId: 'u1',
      conversationId: 'c1',
      botToken: 'bot-token',
    });

    expect(result.summaryText).toBe('[Photo]');
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0];
    expect(attachment.mimeType).toBe('image/jpeg');
    expect(attachment.storagePath.length).toBeGreaterThan(0);
  });
});
