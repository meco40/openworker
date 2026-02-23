import fs from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  extractStoredAttachmentsFromMetadata,
  resolveStoredAttachmentPath,
  type StoredMessageAttachment,
} from '@/server/channels/messages/attachments';
import {
  resolvePersonaAttachmentBucketByMime,
  resolvePersonaScopedStoragePath,
} from '@/server/personas/personaWorkspace';

interface ConsistencyRow {
  message_id: string;
  metadata: string;
  conversation_id: string;
  persona_id: string | null;
}

export interface AttachmentConsistencyOptions {
  repairPruneMissing?: boolean;
  repairNormalizePersonaBuckets?: boolean;
}

export interface AttachmentConsistencyReport {
  scannedMessages: number;
  scannedAttachments: number;
  missingFiles: number;
  bucketMismatches: number;
  repairedMissingPruned: number;
  repairedBucketMoves: number;
  updatedMessages: number;
}

export function runAttachmentConsistencyAudit(
  options: AttachmentConsistencyOptions = {},
): AttachmentConsistencyReport {
  const report: AttachmentConsistencyReport = {
    scannedMessages: 0,
    scannedAttachments: 0,
    missingFiles: 0,
    bucketMismatches: 0,
    repairedMissingPruned: 0,
    repairedBucketMoves: 0,
    updatedMessages: 0,
  };

  const personaSlugById = loadPersonaSlugMap();
  const dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db';
  const db = openSqliteDatabase({ dbPath });

  try {
    const rows = db
      .prepare(
        `
        SELECT m.id AS message_id, m.metadata, m.conversation_id, c.persona_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.metadata IS NOT NULL
          AND m.metadata != ''
        ORDER BY m.created_at ASC
      `,
      )
      .all() as ConsistencyRow[];

    report.scannedMessages = rows.length;
    const updateMetadata = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');

    for (const row of rows) {
      const parsedMetadata = parseMetadataObject(row.metadata);
      const attachments = extractStoredAttachmentsFromMetadata(row.metadata);
      if (attachments.length === 0) {
        continue;
      }

      let changed = false;
      const nextAttachments: StoredMessageAttachment[] = [];

      for (const attachment of attachments) {
        report.scannedAttachments += 1;
        const absolutePath = resolveIfExists(attachment.storagePath);
        const fileExists = Boolean(absolutePath);
        if (!fileExists) {
          report.missingFiles += 1;
          if (options.repairPruneMissing) {
            report.repairedMissingPruned += 1;
            changed = true;
            continue;
          }
        }

        const normalized = attachment.storagePath.replace(/\\/g, '/');
        const personaSlug = row.persona_id ? personaSlugById.get(row.persona_id) : undefined;
        if (
          absolutePath &&
          normalized.startsWith('personas/') &&
          personaSlug &&
          options.repairNormalizePersonaBuckets
        ) {
          const normalizedAttachment = normalizePersonaBucketIfNeeded({
            attachment,
            personaSlug,
            absolutePath,
          });
          if (normalizedAttachment.changed) {
            report.bucketMismatches += 1;
            report.repairedBucketMoves += 1;
            changed = true;
            nextAttachments.push(normalizedAttachment.attachment);
            continue;
          }
        } else if (normalized.startsWith('personas/') && personaSlug) {
          if (isPersonaBucketMismatch(normalized, attachment.mimeType, personaSlug)) {
            report.bucketMismatches += 1;
          }
        }

        nextAttachments.push(attachment);
      }

      if (!changed) {
        continue;
      }

      const nextMetadata = JSON.stringify({
        ...parsedMetadata,
        attachments: nextAttachments,
      });
      updateMetadata.run(nextMetadata, row.message_id);
      report.updatedMessages += 1;
    }
  } finally {
    db.close();
  }

  return report;
}

function loadPersonaSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  const personasDbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db';
  if (!fs.existsSync(personasDbPath)) return map;

  const db = openSqliteDatabase({ dbPath: personasDbPath });
  try {
    const rows = db.prepare('SELECT id, slug FROM personas').all() as Array<{
      id: string;
      slug: string | null;
    }>;
    for (const row of rows) {
      const slug = String(row.slug || '').trim();
      if (!slug) continue;
      map.set(row.id, slug);
    }
  } finally {
    db.close();
  }
  return map;
}

function parseMetadataObject(metadata: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // noop
  }
  return {};
}

function resolveIfExists(storagePath: string): string | null {
  try {
    const absolutePath = resolveStoredAttachmentPath(storagePath);
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    return absolutePath;
  } catch {
    return null;
  }
}

function isPersonaBucketMismatch(
  storagePath: string,
  mimeType: string,
  personaSlug: string,
): boolean {
  const parts = storagePath.split('/');
  if (parts.length < 6) return false;
  if (parts[0] !== 'personas' || parts[1] !== personaSlug || parts[2] !== 'uploads') {
    return false;
  }
  const actualBucket = parts[3];
  const expectedBucket = resolvePersonaAttachmentBucketByMime(mimeType);
  return actualBucket !== expectedBucket;
}

function normalizePersonaBucketIfNeeded(params: {
  attachment: StoredMessageAttachment;
  personaSlug: string;
  absolutePath: string;
}): {
  attachment: StoredMessageAttachment;
  changed: boolean;
} {
  const normalized = params.attachment.storagePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length < 6) {
    return { attachment: params.attachment, changed: false };
  }
  if (parts[0] !== 'personas' || parts[1] !== params.personaSlug || parts[2] !== 'uploads') {
    return { attachment: params.attachment, changed: false };
  }

  const expectedBucket = resolvePersonaAttachmentBucketByMime(params.attachment.mimeType);
  const actualBucket = parts[3];
  if (actualBucket === expectedBucket) {
    return { attachment: params.attachment, changed: false };
  }

  parts[3] = expectedBucket;
  const nextStoragePath = parts.join('/');
  const nextAbsolutePath = resolvePersonaScopedStoragePath(nextStoragePath);
  fs.mkdirSync(path.dirname(nextAbsolutePath), { recursive: true });
  moveFile(params.absolutePath, nextAbsolutePath);

  return {
    attachment: {
      ...params.attachment,
      storagePath: nextStoragePath,
    },
    changed: true,
  };
}

function moveFile(sourcePath: string, targetPath: string): void {
  if (sourcePath === targetPath) return;
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.unlinkSync(sourcePath);
}
