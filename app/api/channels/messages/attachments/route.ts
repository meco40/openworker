import { NextResponse } from 'next/server';
import { getMessageService } from '../../../../../src/server/channels/messages/runtime';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import {
  extractStoredAttachmentsFromMetadata,
  readStoredAttachmentBuffer,
} from '../../../../../src/server/channels/messages/attachments';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const messageId = url.searchParams.get('messageId')?.trim() || '';
    const conversationId = url.searchParams.get('conversationId')?.trim() || '';
    const indexParam = url.searchParams.get('index')?.trim() || '0';
    const index = Number.parseInt(indexParam, 10);

    if (!messageId) {
      return NextResponse.json({ ok: false, error: 'messageId is required' }, { status: 400 });
    }

    if (!Number.isInteger(index) || index < 0) {
      return NextResponse.json(
        { ok: false, error: 'index must be a non-negative integer' },
        { status: 400 },
      );
    }

    const service = getMessageService();
    const message = service.getMessage(messageId, userContext.userId);
    if (!message) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }
    if (conversationId && message.conversationId !== conversationId) {
      return NextResponse.json({ ok: false, error: 'Message not found' }, { status: 404 });
    }

    const attachments = extractStoredAttachmentsFromMetadata(message.metadata);
    const attachment = attachments[index];
    if (!attachment) {
      return NextResponse.json({ ok: false, error: 'Attachment not found' }, { status: 404 });
    }

    let buffer: Buffer;
    try {
      buffer = readStoredAttachmentBuffer(attachment);
    } catch {
      return NextResponse.json({ ok: false, error: 'Attachment file missing' }, { status: 404 });
    }

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': attachment.mimeType || 'application/octet-stream',
        'Content-Length': String(buffer.length),
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `inline; filename="${attachment.name.replace(/"/g, '')}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
