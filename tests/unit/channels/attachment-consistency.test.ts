import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { runAttachmentConsistencyAudit } from '@/server/channels/messages/attachmentConsistency';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { resolvePersonaScopedStoragePath } from '@/server/personas/personaWorkspace';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('attachment consistency audit', () => {
  const cleanupFiles: string[] = [];
  const cleanupDirs: string[] = [];
  const personasRootPath = path.resolve(
    String(process.env.PERSONAS_ROOT_PATH || '.local/personas'),
  );

  afterEach(() => {
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MESSAGES_DB_PATH;
    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  it('reports and prunes missing attachment references', () => {
    const personasDbPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.attach-consistency.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const messagesDbPath = path.resolve(
      getTestArtifactsRoot(),
      `messages.attach-consistency.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupFiles.push(personasDbPath, messagesDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MESSAGES_DB_PATH = messagesDbPath;

    const personaRepo = new PersonaRepository(personasDbPath);
    const persona = personaRepo.createPersona({
      userId: 'u1',
      name: 'Consistency Persona',
      emoji: '🤖',
      vibe: '',
    });
    cleanupDirs.push(path.resolve(personasRootPath, persona.slug));

    const messageRepo = new SqliteMessageRepository(messagesDbPath);
    const conversation = messageRepo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'u1',
      personaId: persona.id,
      title: 'WebChat',
    });
    messageRepo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'x',
      platform: ChannelType.WEBCHAT,
      metadata: {
        attachments: [
          {
            name: 'missing.jpg',
            mimeType: 'image/jpeg',
            size: 123,
            storagePath: `personas/${persona.slug}/uploads/images/abc/missing.jpg`,
          },
        ],
      },
    });

    const dryRun = runAttachmentConsistencyAudit();
    expect(dryRun.missingFiles).toBe(1);
    expect(dryRun.updatedMessages).toBe(0);

    const repaired = runAttachmentConsistencyAudit({ repairPruneMissing: true });
    expect(repaired.repairedMissingPruned).toBe(1);
    expect(repaired.updatedMessages).toBe(1);

    const stored = messageRepo.listMessages(conversation.id, 10, undefined, 'u1')[0];
    const parsed = JSON.parse(String(stored.metadata || '{}')) as { attachments?: unknown[] };
    expect(Array.isArray(parsed.attachments)).toBe(true);
    expect(parsed.attachments).toHaveLength(0);

    messageRepo.close();
    personaRepo.close();
  });

  it('normalizes persona bucket from docs to images for image mime types', () => {
    const personasDbPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.attach-bucket.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const messagesDbPath = path.resolve(
      getTestArtifactsRoot(),
      `messages.attach-bucket.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupFiles.push(personasDbPath, messagesDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MESSAGES_DB_PATH = messagesDbPath;

    const personaRepo = new PersonaRepository(personasDbPath);
    const persona = personaRepo.createPersona({
      userId: 'u1',
      name: 'Bucket Persona',
      emoji: '🤖',
      vibe: '',
    });
    cleanupDirs.push(path.resolve(personasRootPath, persona.slug));

    const messageRepo = new SqliteMessageRepository(messagesDbPath);
    const conversation = messageRepo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'u1',
      personaId: persona.id,
      title: 'WebChat',
    });

    const wrongStoragePath = `personas/${persona.slug}/uploads/docs/abc/photo.jpg`;
    const wrongAbsolutePath = resolvePersonaScopedStoragePath(wrongStoragePath);
    fs.mkdirSync(path.dirname(wrongAbsolutePath), { recursive: true });
    fs.writeFileSync(wrongAbsolutePath, Buffer.from('img', 'utf8'));

    messageRepo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'x',
      platform: ChannelType.WEBCHAT,
      metadata: {
        attachments: [
          {
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: 3,
            storagePath: wrongStoragePath,
          },
        ],
      },
    });

    const report = runAttachmentConsistencyAudit({
      repairNormalizePersonaBuckets: true,
    });
    expect(report.repairedBucketMoves).toBe(1);
    expect(report.updatedMessages).toBe(1);

    const stored = messageRepo.listMessages(conversation.id, 10, undefined, 'u1')[0];
    const parsed = JSON.parse(String(stored.metadata || '{}')) as {
      attachments?: Array<{ storagePath?: string }>;
    };
    const nextStoragePath = String(parsed.attachments?.[0]?.storagePath || '');
    expect(nextStoragePath.includes(`/uploads/images/`)).toBe(true);
    expect(fs.existsSync(wrongAbsolutePath)).toBe(false);
    expect(fs.existsSync(resolvePersonaScopedStoragePath(nextStoragePath))).toBe(true);

    messageRepo.close();
    personaRepo.close();
  });
});
