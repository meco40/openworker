import fs from 'node:fs';
import path from 'node:path';
import { openSqliteDatabase } from '@/server/db/sqlite';
import {
  createPersonaAttachmentStoragePath,
  ensurePersonaWorkspace,
  getMigrationMarkerPath,
  resolvePersonaScopedStoragePath,
} from '@/server/personas/personaWorkspace';
import {
  extractStoredAttachmentsFromMetadata,
  resolveStoredAttachmentPath,
} from '@/server/channels/messages/attachments';
import { PersonaRepository } from '@/server/personas/personaRepository';

const LEGACY_CHAT_UPLOADS_ROOT = path.resolve('.local/uploads/chat');

export function migrateLegacyAttachmentsToPersonaWorkspaces(): {
  migratedFiles: number;
  touchedMessages: number;
} {
  const markerPath = getMigrationMarkerPath();
  if (fs.existsSync(markerPath)) {
    return { migratedFiles: 0, touchedMessages: 0 };
  }

  const personaRepo = new PersonaRepository(process.env.PERSONAS_DB_PATH || '.local/personas.db');
  const personas = personaRepo.listAllPersonas();
  for (const persona of personas) {
    ensurePersonaWorkspace(persona.slug);
  }

  const dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db';
  const db = openSqliteDatabase({ dbPath });

  let migratedFiles = 0;
  let touchedMessages = 0;
  try {
    const rows = db
      .prepare(
        `
        SELECT m.id AS message_id, m.metadata, m.conversation_id, c.persona_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.persona_id IS NOT NULL
          AND m.metadata IS NOT NULL
          AND m.metadata != ''
        `,
      )
      .all() as Array<{
      message_id: string;
      metadata: string;
      conversation_id: string;
      persona_id: string;
    }>;

    const updateMetadata = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');
    const getPersonaById = (id: string) => personaRepo.getPersona(id);

    for (const row of rows) {
      const parsedMetadata = parseMetadataObject(row.metadata);
      const attachments = extractStoredAttachmentsFromMetadata(row.metadata);
      if (attachments.length === 0) {
        continue;
      }

      const persona = getPersonaById(row.persona_id);
      if (!persona?.slug) {
        continue;
      }

      let changed = false;
      const migrated = attachments.map((attachment) => {
        const storagePath = String(attachment.storagePath || '').trim();
        if (!storagePath) return attachment;
        if (storagePath.startsWith('personas/')) return attachment;

        let sourcePath: string;
        try {
          sourcePath = resolveStoredAttachmentPath(storagePath);
        } catch {
          sourcePath = path.resolve(LEGACY_CHAT_UPLOADS_ROOT, storagePath);
        }
        if (!fs.existsSync(sourcePath)) {
          return attachment;
        }

        const nextStoragePath = createPersonaAttachmentStoragePath({
          slug: persona.slug,
          conversationId: row.conversation_id,
          mimeType: attachment.mimeType,
          safeFileName: attachment.name,
        });
        const nextAbsolutePath = resolvePersonaScopedStoragePath(nextStoragePath);
        fs.mkdirSync(path.dirname(nextAbsolutePath), { recursive: true });
        moveFile(sourcePath, nextAbsolutePath);
        migratedFiles += 1;
        changed = true;
        return { ...attachment, storagePath: nextStoragePath };
      });

      if (!changed) continue;

      const nextPayload = JSON.stringify({
        ...parsedMetadata,
        attachments: migrated,
      });
      updateMetadata.run(nextPayload, row.message_id);
      touchedMessages += 1;
    }
  } finally {
    db.close();
    personaRepo.close();
  }

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');

  return { migratedFiles, touchedMessages };
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

function moveFile(sourcePath: string, targetPath: string): void {
  if (sourcePath === targetPath) return;
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') {
      throw error;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.unlinkSync(sourcePath);
}
