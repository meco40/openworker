import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMessageRepository } from '../../../src/server/channels/messages/sqliteMessageRepository';
import { LEGACY_LOCAL_USER_ID } from '../../../src/server/auth/constants';
import { ChannelType } from '../../../types';

const tempPaths: string[] = [];

afterEach(() => {
  for (const filePath of tempPaths.splice(0, tempPaths.length)) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

describe('SqliteMessageRepository migration idempotency', () => {
  it('upgrades a legacy schema without user_id and seq before creating indexes', () => {
    const dbPath = path.join(os.tmpdir(), `messages-legacy-migrate-${Date.now()}.db`);
    tempPaths.push(dbPath);

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        external_chat_id TEXT,
        title TEXT NOT NULL DEFAULT 'Untitled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),
        content TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL,
        external_msg_id TEXT,
        sender_name TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacyDb.exec(`
      CREATE TABLE conversation_context (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
        summary_text TEXT NOT NULL DEFAULT '',
        summary_upto_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    legacyDb
      .prepare(
        `
        INSERT INTO conversations (id, channel_type, external_chat_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run('conv-legacy', ChannelType.WEBCHAT, 'default', 'Legacy Chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    legacyDb
      .prepare(
        `
        INSERT INTO messages (id, conversation_id, role, content, platform, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run('msg-legacy', 'conv-legacy', 'user', 'hello from legacy', ChannelType.WEBCHAT, '2026-01-01T00:00:01.000Z');
    legacyDb.close();

    const repo = new SqliteMessageRepository(dbPath);
    const messages = repo.listMessages('conv-legacy', 20);
    expect(messages).toHaveLength(1);
    expect(messages[0].seq).toBe(1);
    repo.close();

    const migratedDb = new Database(dbPath);
    const conversationColumns = migratedDb
      .prepare('PRAGMA table_info(conversations)')
      .all() as Array<{ name: string }>;
    const messageColumns = migratedDb.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const migratedUserId = migratedDb
      .prepare('SELECT user_id FROM conversations WHERE id = ?')
      .get('conv-legacy') as { user_id: string };

    expect(conversationColumns.map((column) => column.name)).toContain('user_id');
    expect(messageColumns.map((column) => column.name)).toContain('seq');
    expect(migratedUserId.user_id).toBe(LEGACY_LOCAL_USER_ID);

    migratedDb.close();
  });

  it('reopens the same database without migration conflicts and keeps data readable', () => {
    const dbPath = path.join(os.tmpdir(), `messages-migrate-${Date.now()}.db`);
    tempPaths.push(dbPath);

    const first = new SqliteMessageRepository(dbPath);
    const conversation = first.getOrCreateConversation(ChannelType.WEBCHAT, 'default', 'WebChat', 'user-a');
    first.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      platform: ChannelType.WEBCHAT,
    });

    const second = new SqliteMessageRepository(dbPath);
    const messages = second.listMessages(conversation.id, 20, undefined, 'user-a');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');

    first.close();
    second.close();
  });
});
