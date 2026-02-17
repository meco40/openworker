import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

type ParsedMessage = {
  role: 'user' | 'agent';
  content: string;
  createdAt: string;
  sourceLine: number;
};

const DEFAULT_MARKDOWN_PATH = path.join(
  process.cwd(),
  'docs',
  'mock-data',
  '2026-02-17-chat-preview-user-persona-assistant.md',
);
const DEFAULT_MESSAGES_DB_PATH = path.join(process.cwd(), '.local', 'messages.db');
const DEFAULT_PERSONAS_DB_PATH = path.join(process.cwd(), '.local', 'personas.db');

const PERSONA_NAME = 'Lea';
const CHANNEL_TYPE = 'Telegram';
const PLATFORM = 'Telegram';
const EXTERNAL_CHAT_ID = 'seed-lea-memory-chat-v1';
const CONVERSATION_TITLE = 'Telegram Chat';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hasTable(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function parseMessagesFromMarkdown(filePath: string): ParsedMessage[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const dayHeaderRegex = /^##\s+Tag\s+\d+\s+-\s+(\d{4}-\d{2}-\d{2})\b/;
  const extraDayHeaderRegex = /^###\s+Zusatzchat\s+Tag\s+\d+\s+-\s+(\d{4}-\d{2}-\d{2})\b/;
  const messageRegex = /^-\s+(\d{2}):(\d{2})\s+(User|Lea):\s+(.+)$/;

  const perMinuteCounter = new Map<string, number>();
  const messages: ParsedMessage[] = [];
  let currentDate: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const dayMatch = line.match(dayHeaderRegex) || line.match(extraDayHeaderRegex);
    if (dayMatch) {
      currentDate = dayMatch[1];
      continue;
    }

    const msgMatch = line.match(messageRegex);
    if (!msgMatch) continue;
    if (!currentDate) {
      throw new Error(
        `Nachricht ohne Datums-Kontext in Zeile ${i + 1}. Bitte Markdown-Struktur prüfen.`,
      );
    }

    const hour = Number(msgMatch[1]);
    const minute = Number(msgMatch[2]);
    const speaker = msgMatch[3];
    const content = msgMatch[4].trim();
    if (!content) continue;

    const minuteKey = `${currentDate}-${pad2(hour)}:${pad2(minute)}`;
    const minuteCount = perMinuteCounter.get(minuteKey) ?? 0;
    perMinuteCounter.set(minuteKey, minuteCount + 1);
    const seconds = minuteCount % 60;

    const createdAt = `${currentDate}T${pad2(hour)}:${pad2(minute)}:${pad2(seconds)}.000Z`;
    messages.push({
      role: speaker === 'User' ? 'user' : 'agent',
      content,
      createdAt,
      sourceLine: i + 1,
    });
  }

  return messages;
}

function resolvePersona(
  personasDb: BetterSqlite3.Database,
  personaName: string,
): {
  id: string;
  userId: string;
} {
  const row = personasDb
    .prepare(
      `
      SELECT id, user_id
      FROM personas
      WHERE name = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(personaName) as { id: string; user_id: string } | undefined;

  if (!row) {
    throw new Error(`Persona "${personaName}" wurde in personas.db nicht gefunden.`);
  }

  return { id: row.id, userId: row.user_id };
}

function seedConversation(): void {
  if (!fs.existsSync(DEFAULT_MARKDOWN_PATH)) {
    throw new Error(`Markdown-Datei nicht gefunden: ${DEFAULT_MARKDOWN_PATH}`);
  }
  if (!fs.existsSync(DEFAULT_MESSAGES_DB_PATH)) {
    throw new Error(`messages.db nicht gefunden: ${DEFAULT_MESSAGES_DB_PATH}`);
  }
  if (!fs.existsSync(DEFAULT_PERSONAS_DB_PATH)) {
    throw new Error(`personas.db nicht gefunden: ${DEFAULT_PERSONAS_DB_PATH}`);
  }

  const parsed = parseMessagesFromMarkdown(DEFAULT_MARKDOWN_PATH);
  if (parsed.length === 0) {
    throw new Error('Keine Chat-Nachrichten aus Markdown extrahiert.');
  }

  const personasDb = new BetterSqlite3(DEFAULT_PERSONAS_DB_PATH, { readonly: true });
  const { id: personaId, userId } = resolvePersona(personasDb, PERSONA_NAME);
  personasDb.close();

  const messagesDb = new BetterSqlite3(DEFAULT_MESSAGES_DB_PATH);
  messagesDb.pragma('foreign_keys = ON');
  messagesDb.pragma('busy_timeout = 5000');

  const existingConversations = messagesDb
    .prepare(
      `
      SELECT id
      FROM conversations
      WHERE external_chat_id = ? AND user_id = ?
    `,
    )
    .all(EXTERNAL_CHAT_ID, userId) as Array<{ id: string }>;

  const firstCreatedAt = parsed[0].createdAt;
  const lastCreatedAt = parsed[parsed.length - 1].createdAt;

  const runTx = messagesDb.transaction(() => {
    for (const existingConversation of existingConversations) {
      const convId = existingConversation.id;
      messagesDb.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
      if (hasTable(messagesDb, 'conversation_context')) {
        messagesDb
          .prepare('DELETE FROM conversation_context WHERE conversation_id = ?')
          .run(convId);
      }
      for (const table of [
        'knowledge_ingestion_checkpoints',
        'knowledge_episodes',
        'knowledge_meeting_ledger',
        'knowledge_retrieval_audit',
      ]) {
        if (!hasTable(messagesDb, table)) continue;
        messagesDb.prepare(`DELETE FROM "${table}" WHERE conversation_id = ?`).run(convId);
      }
      messagesDb
        .prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
        .run(convId, userId);
    }

    const conversationId = crypto.randomUUID();
    messagesDb
      .prepare(
        `
        INSERT INTO conversations (
          id, channel_type, external_chat_id, user_id, title, persona_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        conversationId,
        CHANNEL_TYPE,
        EXTERNAL_CHAT_ID,
        userId,
        CONVERSATION_TITLE,
        personaId,
        firstCreatedAt,
        lastCreatedAt,
      );

    const insertMessage = messagesDb.prepare(
      `
      INSERT INTO messages (
        id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `,
    );

    let userCount = 0;
    let agentCount = 0;
    for (let i = 0; i < parsed.length; i++) {
      const msg = parsed[i];
      const seq = i + 1;
      const messageId = `msg-seed-${seq}-${crypto.randomUUID().slice(0, 8)}`;
      insertMessage.run(
        messageId,
        conversationId,
        seq,
        msg.role,
        msg.content,
        PLATFORM,
        msg.createdAt,
      );
      if (msg.role === 'user') userCount += 1;
      else agentCount += 1;
    }

    return {
      conversationId,
      total: parsed.length,
      userCount,
      agentCount,
      firstCreatedAt,
      lastCreatedAt,
    };
  });

  const result = runTx();
  messagesDb.close();

  console.log('Lea-Chat wurde erfolgreich angelegt:');
  console.log(JSON.stringify(result, null, 2));
}

try {
  seedConversation();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fehler beim Seed: ${message}`);
  process.exit(1);
}
