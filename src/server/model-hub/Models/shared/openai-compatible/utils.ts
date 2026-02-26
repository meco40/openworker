import { readStoredAttachmentBuffer } from '@/server/channels/messages/attachments';
import type { AttachmentItem } from './types';
import { MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH, THINK_BLOCK_REGEX } from './constants';

export function normalizeBearerSecret(secret: string): string {
  let normalized = secret.trim();
  normalized = normalized.replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
  normalized = normalized.replace(/^['"`](.*)['"`]$/s, '$1').trim();
  normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  normalized = normalized.replace(/\\[nrt]/g, '');
  normalized = normalized.replace(/[\r\n\t]/g, '');
  return normalized;
}

export function buildOptionalAuthHeaders(secret: string): Record<string, string> {
  const normalizedSecret = normalizeBearerSecret(secret);
  if (!normalizedSecret) return {};
  return { Authorization: `Bearer ${normalizedSecret}` };
}

export function isImageAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

export function isTextAttachment(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

export function readTextAttachmentSnippet(attachment: AttachmentItem): string | null {
  try {
    const bytes = readStoredAttachmentBuffer(attachment);
    if (!bytes.length) return null;
    const text = bytes.toString('utf8').replaceAll('\u0000', '').trim();
    if (!text) return null;
    return text.slice(0, MAX_TEXT_ATTACHMENT_SNIPPET_LENGTH);
  } catch {
    return null;
  }
}

export function attachmentFallbackText(attachment: AttachmentItem): string {
  return `[Attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)]`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export function buildModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function buildChatUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function stripThinkingBlocks(text: string): string {
  return text.replace(THINK_BLOCK_REGEX, '').trim();
}
