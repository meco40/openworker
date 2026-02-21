import type { GatewayRequest } from '@/server/model-hub/Models/types';
import {
  readStoredAttachmentAsDataUrl,
  readStoredAttachmentBuffer,
} from '@/server/channels/messages/attachments';

export function isImageAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

export function isTextAttachment(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

export function toAttachmentFallbackText(name: string, mimeType: string, size: number): string {
  return `[Attachment: ${name} (${mimeType}, ${size} bytes)]`;
}

export function readTextAttachmentSnippet(
  attachment: NonNullable<GatewayRequest['messages'][number]['attachments']>[number],
): string | null {
  try {
    const bytes = readStoredAttachmentBuffer(attachment);
    if (!bytes.length) return null;
    const text = bytes
      .toString('utf8')
      .replaceAll('\u0000', '')
      .trim();
    if (!text) return null;
    return text.slice(0, 12_000);
  } catch {
    return null;
  }
}

export function buildCodexUserContentParts(
  message: GatewayRequest['messages'][number],
  includeBinaryAttachments: boolean,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const trimmedContent = message.content.trim();
  if (trimmedContent) {
    parts.push({ type: 'input_text', text: trimmedContent });
  }

  for (const attachment of message.attachments || []) {
    const mimeType = attachment.mimeType || 'application/octet-stream';
    if (includeBinaryAttachments && isImageAttachment(mimeType)) {
      const dataUrl = readStoredAttachmentAsDataUrl(attachment);
      if (dataUrl) {
        parts.push({
          type: 'input_image',
          image_url: dataUrl,
        });
        continue;
      }
    }

    if (includeBinaryAttachments && isTextAttachment(mimeType)) {
      const snippet = readTextAttachmentSnippet(attachment);
      if (snippet) {
        parts.push({
          type: 'input_text',
          text: `Attachment ${attachment.name} (${mimeType}):\n${snippet}`,
        });
        continue;
      }
    }

    parts.push({
      type: 'input_text',
      text: toAttachmentFallbackText(attachment.name, mimeType, attachment.size),
    });
  }

  return parts;
}
