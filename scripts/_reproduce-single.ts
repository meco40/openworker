/**
 * Minimal reproduction: process ONE window and check what gets stored.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import SqliteDatabase from 'better-sqlite3';
import { getKnowledgeIngestionService } from '../src/server/knowledge/runtime';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const CONVERSATION_ID = '8c010a84-74b8-4c9d-beb7-b93cfef673e7';

async function main() {
  // Reset Lea's checkpoint so we can re-process the first window
  try {
    const db = new SqliteDatabase('.local/messages.db');
    db.prepare('DELETE FROM knowledge_ingestion_checkpoints WHERE persona_id = ?').run(PERSONA_ID);
    db.prepare('DELETE FROM knowledge_episodes WHERE persona_id = ?').run(PERSONA_ID);
    db.prepare('DELETE FROM knowledge_entities WHERE persona_id = ?').run(PERSONA_ID);
    db.prepare('DELETE FROM knowledge_events WHERE persona_id = ?').run(PERSONA_ID);
    db.prepare('DELETE FROM knowledge_meeting_ledger WHERE persona_id = ?').run(PERSONA_ID);
    db.close();
    console.log('[setup] Cleaned Lea data');
  } catch (e) {
    console.error('Clean error:', e);
  }

  // Get first 25 messages
  const msgDb = new SqliteDatabase('.local/messages.db', { readonly: true });
  const messages = msgDb
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 25')
    .all(CONVERSATION_ID) as Array<Record<string, unknown>>;
  msgDb.close();
  console.log(
    `[setup] Got ${messages.length} messages, seq ${messages[0]?.seq}..${messages[messages.length - 1]?.seq}`,
  );

  // Count before
  const countBefore = new SqliteDatabase('.local/messages.db', { readonly: true })
    .prepare('SELECT COUNT(*) as c FROM knowledge_episodes WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(`[before] Episodes: ${countBefore.c}`);

  // Call ingestConversationWindow
  const service = getKnowledgeIngestionService();
  console.log('[run] Calling ingestConversationWindow...');

  try {
    await service.ingestConversationWindow({
      conversationId: CONVERSATION_ID,
      userId: 'legacy-local-user',
      personaId: PERSONA_ID,
      messages: messages.map((m) => ({
        id: String(m.id),
        seq: Number(m.seq),
        role: String(m.role) as 'user' | 'assistant',
        content: String(m.content),
        createdAt: String(m.created_at),
        conversationId: CONVERSATION_ID,
      })),
    });
    console.log('[run] ingestConversationWindow returned (no error)');
  } catch (e) {
    console.error('[run] ingestConversationWindow THREW:', e);
  }

  // Count after
  const dbAfter = new SqliteDatabase('.local/messages.db', { readonly: true });
  const countAfter = dbAfter
    .prepare('SELECT COUNT(*) as c FROM knowledge_episodes WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(`[after] Episodes: ${countAfter.c}`);

  const eventsAfter = dbAfter
    .prepare('SELECT COUNT(*) as c FROM knowledge_events WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(`[after] Events: ${eventsAfter.c}`);

  const entitiesAfter = dbAfter
    .prepare('SELECT COUNT(*) as c FROM knowledge_entities WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(`[after] Entities: ${entitiesAfter.c}`);

  const ledgerAfter = dbAfter
    .prepare('SELECT COUNT(*) as c FROM knowledge_meeting_ledger WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(`[after] Ledger: ${ledgerAfter.c}`);

  const checkpointAfter = dbAfter
    .prepare('SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id = ?')
    .get(PERSONA_ID);
  console.log(`[after] Checkpoint:`, JSON.stringify(checkpointAfter));

  dbAfter.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
