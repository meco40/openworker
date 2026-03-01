import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelType } from '@/shared/domain/types';
import { SqliteMessageRepository } from '@/server/channels/messages/sqliteMessageRepository';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { migrateLegacyAttachmentsToPersonaWorkspaces } from '@/server/personas/personaWorkspaceMigration';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('persona workspace lifecycle', () => {
  const cleanupFiles: string[] = [];
  const cleanupDirs: string[] = [];
  const previousAttachmentsDir = process.env.CHAT_ATTACHMENTS_DIR;

  function createTestPersonasRootPath(): string {
    const rootPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.test.workspace.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    cleanupDirs.push(rootPath);
    process.env.PERSONAS_ROOT_PATH = rootPath;
    return rootPath;
  }

  afterEach(() => {
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MESSAGES_DB_PATH;
    delete process.env.PERSONAS_ROOT_PATH;
    if (previousAttachmentsDir === undefined) {
      delete process.env.CHAT_ATTACHMENTS_DIR;
    } else {
      process.env.CHAT_ATTACHMENTS_DIR = previousAttachmentsDir;
    }
    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore in tests
      }
    }
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore in tests
        }
      }
    }
    try {
      const attachmentRoot = path.resolve(
        String(process.env.CHAT_ATTACHMENTS_DIR || '.local/uploads/chat'),
      );
      fs.rmSync(attachmentRoot, { recursive: true, force: true });
    } catch {
      // ignore in tests
    }
  });

  it('creates slug + workspace and rejects duplicate slug', () => {
    const personasRootPath = createTestPersonasRootPath();
    const repo = new PersonaRepository(':memory:');

    const first = repo.createPersona({
      userId: 'u1',
      name: 'Nata Girl',
      emoji: '🤖',
      vibe: '',
    });

    expect(first.slug).toBe('nata_girl');
    expect(fs.existsSync(path.join(personasRootPath, 'nata_girl', 'uploads', 'images'))).toBe(true);
    expect(fs.existsSync(path.join(personasRootPath, 'nata_girl', 'uploads', 'docs'))).toBe(true);
    expect(fs.existsSync(path.join(personasRootPath, 'nata_girl', 'knowledge'))).toBe(true);

    expect(() =>
      repo.createPersona({
        userId: 'u2',
        name: 'Nata Girl',
        emoji: '🤖',
        vibe: '',
      }),
    ).toThrow(/slug already exists/i);

    repo.close();
  });

  it('renames workspace folder when persona name changes', () => {
    const personasRootPath = createTestPersonasRootPath();
    const repo = new PersonaRepository(':memory:');
    const created = repo.createPersona({
      userId: 'u1',
      name: 'Nata Girl',
      emoji: '🤖',
      vibe: '',
    });

    const oldPath = path.join(personasRootPath, created.slug);
    expect(fs.existsSync(oldPath)).toBe(true);

    repo.updatePersona(created.id, { name: 'Nata Prime' });

    const updated = repo.getPersona(created.id);
    expect(updated?.slug).toBe('nata_prime');
    expect(fs.existsSync(path.join(personasRootPath, 'nata_prime'))).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    repo.close();
  });

  it('migrates legacy chat uploads into persona workspace and rewrites metadata paths', () => {
    const personasRootPath = createTestPersonasRootPath();
    const personasDbPath = path.resolve(
      getTestArtifactsRoot(),
      `personas.workspace.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    const messagesDbPath = path.resolve(
      getTestArtifactsRoot(),
      `messages.workspace.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupFiles.push(personasDbPath, messagesDbPath);
    process.env.PERSONAS_DB_PATH = personasDbPath;
    process.env.MESSAGES_DB_PATH = messagesDbPath;

    const personaRepo = new PersonaRepository(personasDbPath);
    const persona = personaRepo.createPersona({
      userId: 'u1',
      name: 'Nata Girl',
      emoji: '🤖',
      vibe: '',
    });

    const messageRepo = new SqliteMessageRepository(messagesDbPath);
    const conversation = messageRepo.createConversation({
      channelType: ChannelType.WEBCHAT,
      externalChatId: 'default',
      userId: 'u1',
      title: 'WebChat',
      personaId: persona.id,
    });

    const legacyRelative = 'u1/c1/legacy-note.txt';
    const attachmentRoot = path.resolve(
      String(process.env.CHAT_ATTACHMENTS_DIR || '.local/uploads/chat'),
    );
    const legacyAbsolute = path.resolve(attachmentRoot, legacyRelative);
    fs.mkdirSync(path.dirname(legacyAbsolute), { recursive: true });
    fs.writeFileSync(legacyAbsolute, Buffer.from('legacy', 'utf8'));

    messageRepo.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      platform: ChannelType.WEBCHAT,
      metadata: {
        attachments: [
          {
            name: 'legacy-note.txt',
            mimeType: 'text/plain',
            size: 6,
            storagePath: legacyRelative,
          },
        ],
      },
    });

    const result = migrateLegacyAttachmentsToPersonaWorkspaces();
    expect(result.migratedFiles).toBe(1);
    expect(result.touchedMessages).toBe(1);

    const migratedMessage = messageRepo.listMessages(conversation.id, 10, undefined, 'u1')[0];
    const metadata = JSON.parse(String(migratedMessage.metadata || '{}')) as {
      attachments?: Array<{ storagePath?: string }>;
    };
    const rewrittenPath = String(metadata.attachments?.[0]?.storagePath || '');
    expect(rewrittenPath.startsWith('personas/nata_girl/uploads/docs/')).toBe(true);
    expect(fs.existsSync(path.resolve(attachmentRoot, legacyRelative))).toBe(false);
    expect(fs.existsSync(path.join(personasRootPath, '.migration-v1.done'))).toBe(true);

    messageRepo.close();
    personaRepo.close();
  });
});
