/**
 * Clean knowledge data + reset checkpoint for a fresh ingestion run.
 * Usage:
 *   npx tsx scripts/_clean-lea-fresh.ts                  # default: Lea
 *   npx tsx scripts/_clean-lea-fresh.ts --persona "Nata Girl"
 */
import SqliteDatabase from 'better-sqlite3';
import fs from 'node:fs';

// ── Resolve persona by name or ID ───────────────────────────
const DEFAULT_PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';

function resolvePersona(): { id: string; name: string } {
  const idx = process.argv.indexOf('--persona');
  if (idx === -1) return { id: DEFAULT_PERSONA_ID, name: 'Lea' };

  const needle = (process.argv[idx + 1] || '').trim();
  if (!needle) return { id: DEFAULT_PERSONA_ID, name: 'Lea' };

  // Try to look up by name in personas DB
  const personaDbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db';
  if (fs.existsSync(personaDbPath)) {
    const pdb = new SqliteDatabase(personaDbPath, { readonly: true });
    try {
      const row = pdb
        .prepare('SELECT id, name FROM personas WHERE name = ? OR id = ?')
        .get(needle, needle) as { id: string; name: string } | undefined;
      if (row) return row;
    } finally {
      pdb.close();
    }
  }
  // Fallback: treat needle as ID
  return { id: needle, name: needle };
}

const persona = resolvePersona();
const PERSONA_ID = persona.id;
const db = new SqliteDatabase('.local/messages.db');

const tables = [
  'knowledge_episodes',
  'knowledge_entities',
  'knowledge_events',
  'knowledge_meeting_ledger',
  'knowledge_conversation_summaries',
  'knowledge_retrieval_audit',
];

console.log(`[clean] Deleting knowledge data for "${persona.name}" (${PERSONA_ID})...`);

for (const t of tables) {
  try {
    const result = db.prepare(`DELETE FROM ${t} WHERE persona_id = ?`).run(PERSONA_ID);
    console.log(`  ${t}: ${result.changes} rows deleted`);
  } catch {
    console.log(`  ${t}: skipped (no persona_id or not found)`);
  }
}

// Delete orphaned aliases (for entities that no longer exist for this persona)
try {
  const result = db
    .prepare(
      `
    DELETE FROM knowledge_entity_aliases 
    WHERE entity_id NOT IN (SELECT id FROM knowledge_entities)
  `,
    )
    .run();
  console.log(`  knowledge_entity_aliases (orphaned): ${result.changes} rows deleted`);
} catch {
  /* ignore */
}

// Delete orphaned relations
try {
  const result = db
    .prepare(
      `
    DELETE FROM knowledge_entity_relations 
    WHERE source_entity_id NOT IN (SELECT id FROM knowledge_entities)
       OR target_entity_id NOT IN (SELECT id FROM knowledge_entities)
  `,
    )
    .run();
  console.log(`  knowledge_entity_relations (orphaned): ${result.changes} rows deleted`);
} catch {
  /* ignore */
}

// Reset checkpoint
try {
  const result = db
    .prepare('DELETE FROM knowledge_ingestion_checkpoints WHERE persona_id = ?')
    .run(PERSONA_ID);
  console.log(`  knowledge_ingestion_checkpoints: ${result.changes} rows deleted`);
} catch {
  /* ignore */
}

db.close();
console.log('[clean] Done ✓');
