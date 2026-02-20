/**
 * Diagnose entity extraction for Lea.
 *
 * 1. Save the missing checkpoint for Lea (she has 12 episodes but no checkpoint)
 * 2. Run ONE extraction on 20 messages to see what the LLM returns for entities
 * 3. Print the raw LLM output + parsed entities
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import SqliteDatabase from 'better-sqlite3';
import { getKnowledgeExtractor, getKnowledgeRepository } from '@/server/knowledge/runtime';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const CONVERSATION_ID = '8c010a84-74b8-4c9d-beb7-b93cfef673e7';

async function main() {
  // ── Step 1: Fix missing checkpoint ──────────────────────
  const repo = getKnowledgeRepository();
  const existing = repo.getIngestionCheckpoint(CONVERSATION_ID, PERSONA_ID);
  if (!existing) {
    console.log('[fix] No checkpoint found for Lea — saving checkpoint at seq 598');
    repo.upsertIngestionCheckpoint({
      conversationId: CONVERSATION_ID,
      personaId: PERSONA_ID,
      lastSeq: 598,
    });
    console.log('[fix] Checkpoint saved ✓');
  } else {
    console.log(`[fix] Checkpoint already exists: lastSeq=${existing.lastSeq}`);
  }

  // ── Step 2: Extract a small sample to diagnose entities ──
  const msgDb = new SqliteDatabase('.local/messages.db', { readonly: true });
  const sampleMessages = msgDb
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 20')
    .all(CONVERSATION_ID) as Array<{
    id: string;
    conversation_id: string;
    seq: number;
    role: string;
    content: string;
    created_at: string;
    [key: string]: unknown;
  }>;
  msgDb.close();

  console.log(
    `\n[diag] Got ${sampleMessages.length} sample messages (seq ${sampleMessages[0]?.seq}..${sampleMessages[sampleMessages.length - 1]?.seq})`,
  );

  const extractor = getKnowledgeExtractor();

  console.log('[diag] Running extraction on 20 messages...\n');

  const result = await extractor.extract({
    messages: sampleMessages.map((m) => ({
      id: m.id,
      conversationId: CONVERSATION_ID,
      seq: m.seq,
      role:
        String(m.role).toLowerCase() === 'assistant'
          ? 'agent'
          : String(m.role).toLowerCase() === 'system'
            ? 'system'
            : 'user',
      content: m.content,
      platform: 'WebChat' as never,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: m.created_at,
    })),
    conversationId: CONVERSATION_ID,
    userId: 'legacy-local-user',
    personaId: PERSONA_ID,
  });

  console.log('=== Extraction Result ===');
  console.log(`  teaser length: ${result.teaser.length} chars`);
  console.log(`  episode length: ${result.episode.length} chars`);
  console.log(`  facts: ${result.facts.length}`);
  console.log(`  events: ${result.events.length}`);
  console.log(`  entities: ${result.entities.length}`);
  console.log(`  meetingLedger confidence: ${result.meetingLedger.confidence}`);

  if (result.entities.length > 0) {
    console.log('\n=== Entities ===');
    for (const e of result.entities) {
      console.log(`  ${e.name} (${e.category}, owner=${e.owner})`);
      if (e.aliases.length > 0) console.log(`    aliases: ${e.aliases.join(', ')}`);
      if (e.relations.length > 0) console.log(`    relations: ${JSON.stringify(e.relations)}`);
    }
  } else {
    console.log('\n[diag] ⚠ NO ENTITIES extracted — this confirms the issue');
    console.log('[diag] meetingLedger confidence:', result.meetingLedger.confidence);
    if (result.meetingLedger.confidence <= 0.35) {
      console.log('[diag] → Low confidence (0.35) = FALLBACK was used, LLM call likely FAILED');
    } else {
      console.log(
        '[diag] → Higher confidence = LLM response was parsed but entities array was empty',
      );
    }
  }

  if (result.events.length > 0) {
    console.log('\n=== Events ===');
    for (const ev of result.events) {
      console.log(
        `  ${ev.eventType}: ${ev.subject} → ${ev.counterpart || '(none)'} [${ev.timeExpression}]`,
      );
    }
  }

  console.log('\n=== Sample Facts ===');
  for (const f of result.facts.slice(0, 5)) {
    console.log(`  • ${f}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
