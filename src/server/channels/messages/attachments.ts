import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const DEFAULT_ATTACHMENT_ROOT = '.local/uploads/chat';

const ALLOWED_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export interface IncomingMessageAttachmentPayload {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export interface StoredMessageAttachment {
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  sha256?: string;
}

function toBase64Url(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'default';
  return Buffer.from(normalized, 'utf8').toString('base64url');
}

function getAttachmentRootDir(): string {
  const configured = process.env.CHAT_ATTACHMENTS_DIR?.trim();
  return path.resolve(configured || DEFAULT_ATTACHMENT_ROOT);
}

function ensureWithinRoot(candidatePath: string): string {
  const root = getAttachmentRootDir();
  const resolved = path.resolve(candidatePath);
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
    throw new Error('Attachment path is outside of configured storage root.');
  }
  return resolved;
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const trimmed = dataUrl.trim();
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error('Attachment payload must be a base64 data URL.');
  }

  const mimeType = String(match[1] || '')
    .trim()
    .toLowerCase();
  const base64Payload = String(match[2] || '').replace(/\s+/g, '');
  if (!mimeType || !base64Payload) {
    throw new Error('Attachment data URL is malformed.');
  }

  try {
    return {
      mimeType,
      bytes: Buffer.from(base64Payload, 'base64'),
    };
  } catch {
    throw new Error('Attachment base64 payload is invalid.');
  }
}

function sanitizeFileName(name: string, mimeType: string): string {
  const fallbackExt = EXTENSION_BY_MIME_TYPE[mimeType] || 'bin';
  const base = path
    .basename(name || `attachment.${fallbackExt}`)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120);
  if (!base) {
    return `attachment.${fallbackExt}`;
  }
  if (base.includes('.')) {
    return base;
  }
  return `${base}.${fallbackExt}`;
}

function toStoredAttachment(entry: unknown): StoredMessageAttachment | null {
  if (!entry || typeof entry !== 'object') return null;
  const typed = entry as {
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
    storagePath?: unknown;
    sha256?: unknown;
  };
  if (
    typeof typed.name !== 'string' ||
    typeof typed.mimeType !== 'string' ||
    typeof typed.storagePath !== 'string'
  ) {
    return null;
  }
  const size = typeof typed.size === 'number' && Number.isFinite(typed.size) ? typed.size : 0;
  const sha256 = typeof typed.sha256 === 'string' ? typed.sha256 : '';
  const attachment: StoredMessageAttachment = {
    name: typed.name,
    mimeType: typed.mimeType,
    size: Math.max(0, size),
    storagePath: typed.storagePath,
  };
  if (sha256) {
    attachment.sha256 = sha256;
  }
  return attachment;
}

export function extractStoredAttachmentsFromMetadata(
  metadata: string | null | undefined,
): StoredMessageAttachment[] {
  if (!metadata?.trim()) return [];

  try {
    const parsed = JSON.parse(metadata) as { attachments?: unknown };
    if (!Array.isArray(parsed.attachments)) return [];
    return parsed.attachments
      .map((entry) => toStoredAttachment(entry))
      .filter((entry): entry is StoredMessageAttachment => Boolean(entry));
  } catch {
    return [];
  }
}

export function buildMessageAttachmentMetadata(
  attachments: StoredMessageAttachment[] | undefined,
): Record<string, unknown> | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return { attachments };
}

export function resolveStoredAttachmentPath(storagePath: string): string {
  const normalized = storagePath.trim();
  if (!normalized) {
    throw new Error('Attachment storage path is empty.');
  }
  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }

  const root = getAttachmentRootDir();
  const resolved = path.resolve(root, normalized);
  return ensureWithinRoot(resolved);
}

export function readStoredAttachmentBuffer(attachment: StoredMessageAttachment): Buffer {
  const resolvedPath = resolveStoredAttachmentPath(attachment.storagePath);
  return fs.readFileSync(resolvedPath);
}

export function readStoredAttachmentAsDataUrl(attachment: StoredMessageAttachment): string | null {
  try {
    const bytes = readStoredAttachmentBuffer(attachment);
    if (bytes.length === 0) return null;
    return `data:${attachment.mimeType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export function persistIncomingAttachment(input: {
  userId: string;
  conversationId: string;
  attachment: IncomingMessageAttachmentPayload;
}): StoredMessageAttachment {
  const declaredType = String(input.attachment.type || '')
    .trim()
    .toLowerCase();
  const parsed = parseDataUrl(input.attachment.dataUrl || '');
  const mimeType = declaredType || parsed.mimeType;

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Attachment MIME type is not allowed: ${mimeType || 'unknown'}`);
  }

  if (parsed.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is too large (max ${MAX_ATTACHMENT_BYTES} bytes).`);
  }

  const declaredSize =
    typeof input.attachment.size === 'number' && Number.isFinite(input.attachment.size)
      ? Math.max(0, Math.floor(input.attachment.size))
      : parsed.bytes.length;
  if (declaredSize !== parsed.bytes.length) {
    throw new Error('Attachment size mismatch between metadata and payload.');
  }

  const root = getAttachmentRootDir();
  const userSegment = toBase64Url(input.userId);
  const conversationSegment = toBase64Url(input.conversationId);
  const safeFileName = sanitizeFileName(input.attachment.name, mimeType);
  const uniquePrefix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const relativePath = `${userSegment}/${conversationSegment}/${uniquePrefix}-${safeFileName}`;
  const absolutePath = ensureWithinRoot(path.resolve(root, relativePath));

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, parsed.bytes);

  return {
    name: safeFileName,
    mimeType,
    size: parsed.bytes.length,
    storagePath: relativePath,
    sha256: crypto.createHash('sha256').update(parsed.bytes).digest('hex'),
  };
}
