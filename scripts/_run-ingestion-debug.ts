/**
 * Minimal ingestion runner with full error tracing.
 */
import {
  getKnowledgeIngestionCursor,
  getKnowledgeIngestionService,
} from '@/server/knowledge/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';

async function main() {
  console.log('[debug] Getting persona...');
  const persona = getPersonaRepository().getPersona(PERSONA_ID);
  console.log('[debug] Persona:', persona?.name, 'type:', persona?.memoryPersonaType);

  console.log('[debug] Getting cursor...');
  const cursor = getKnowledgeIngestionCursor();

  console.log('[debug] Getting pending windows...');
  const windows = cursor.getPendingWindows();
  const leaWindows = windows.filter((w) => w.personaId === PERSONA_ID);
  console.log(`[debug] ${leaWindows.length} windows for Lea`);

  if (leaWindows.length === 0) {
    console.log('[debug] No windows to process. Done.');
    return;
  }

  console.log('[debug] Getting ingestion service...');
  const service = getKnowledgeIngestionService();

  // Process only the FIRST window for diagnosis
  const firstWindow = leaWindows[0];
  console.log(
    `[debug] Processing window 1: seq ${firstWindow.messages[0]?.seq}..${firstWindow.messages[firstWindow.messages.length - 1]?.seq} (${firstWindow.messages.length} msgs)`,
  );

  try {
    await service.ingestConversationWindow({
      conversationId: firstWindow.conversationId,
      userId: firstWindow.userId,
      personaId: firstWindow.personaId,
      messages: firstWindow.messages,
      personaContext: persona ? { name: persona.name } : undefined,
    });
    cursor.markWindowProcessed(firstWindow);
    console.log('[debug] ✓ Window 1 processed successfully');
  } catch (error) {
    console.error('[debug] ✗ Window 1 FAILED:');
    console.error(error);
  }

  // Quick DB check
  const Database = (await import('better-sqlite3')).default;
  const db = new Database('.local/messages.db', { readonly: true });
  const episodes = db
    .prepare('SELECT COUNT(*) as c FROM knowledge_episodes WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  const entities = db
    .prepare('SELECT COUNT(*) as c FROM knowledge_entities WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  const events = db
    .prepare('SELECT COUNT(*) as c FROM knowledge_events WHERE persona_id = ?')
    .get(PERSONA_ID) as { c: number };
  console.log(
    `\n[debug] DB after window 1: episodes=${episodes.c} entities=${entities.c} events=${events.c}`,
  );

  // Show entity details if any
  if (entities.c > 0) {
    const rows = db
      .prepare(
        'SELECT canonical_name, category, owner FROM knowledge_entities WHERE persona_id = ? LIMIT 20',
      )
      .all(PERSONA_ID);
    console.log('\n[debug] Entities:');
    for (const row of rows as Array<{ canonical_name: string; category: string; owner: string }>) {
      console.log(`  ${row.canonical_name} (${row.category}) owner=${row.owner}`);
    }
  }

  // Show event details
  if (events.c > 0) {
    const rows = db
      .prepare(
        'SELECT event_type, subject, counterpart, speaker_role FROM knowledge_events WHERE persona_id = ? LIMIT 20',
      )
      .all(PERSONA_ID);
    console.log('\n[debug] Events:');
    for (const row of rows as Array<{
      event_type: string;
      subject: string;
      counterpart: string;
      speaker_role: string;
    }>) {
      console.log(
        `  ${row.event_type}: ${row.subject} → ${row.counterpart} (speaker=${row.speaker_role})`,
      );
    }
  }

  db.close();
}

main().catch((err) => {
  console.error('[debug] FATAL:', err);
  process.exit(1);
});
