/**
 * Quick status check after ingestion run
 */
import SqliteDatabase from 'better-sqlite3';

const PID = '48979798-6783-4ae2-895b-1d0222b2af26';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });

// Counts
const tables = [
  'knowledge_episodes',
  'knowledge_entities',
  'knowledge_events',
  'knowledge_meeting_ledger',
];
for (const t of tables) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE persona_id = ?`).get(PID) as {
    c: number;
  };
  console.log(`${t.replace('knowledge_', '')}: ${row.c}`);
}

// Aliases
const aliasCount = db
  .prepare(
    `SELECT COUNT(*) as c FROM knowledge_entity_aliases WHERE entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?)`,
  )
  .get(PID) as { c: number };
console.log(`aliases: ${aliasCount.c}`);

// Relations
const relCount = db
  .prepare(
    `SELECT COUNT(*) as c FROM knowledge_entity_relations WHERE source_entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?) OR target_entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?)`,
  )
  .get(PID, PID) as { c: number };
console.log(`relations: ${relCount.c}`);

// Checkpoint
const cp = db
  .prepare('SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id = ?')
  .get(PID) as Record<string, unknown> | undefined;
console.log(`\ncheckpoint: ${cp ? JSON.stringify(cp) : 'NONE'}`);

// Episode seq ranges
console.log('\n--- Episode seq ranges ---');
const eps = db
  .prepare(
    'SELECT source_seq_start, source_seq_end, topic_key, teaser FROM knowledge_episodes WHERE persona_id = ? ORDER BY source_seq_start',
  )
  .all(PID) as Array<{
  source_seq_start: number;
  source_seq_end: number;
  topic_key: string;
  teaser: string;
}>;
for (const e of eps) {
  console.log(
    `  seq ${e.source_seq_start}-${e.source_seq_end}: ${e.topic_key} | ${e.teaser.substring(0, 80)}...`,
  );
}

// Event distribution
console.log('\n--- Events by type ---');
const events = db
  .prepare(
    'SELECT event_type, COUNT(*) as c FROM knowledge_events WHERE persona_id = ? GROUP BY event_type ORDER BY c DESC',
  )
  .all(PID) as Array<{ event_type: string; c: number }>;
for (const ev of events) {
  console.log(`  ${ev.event_type}: ${ev.c}`);
}

// Entity list
console.log('\n--- Entities ---');
const ents = db
  .prepare(
    'SELECT canonical_name, category, owner FROM knowledge_entities WHERE persona_id = ? ORDER BY canonical_name',
  )
  .all(PID) as Array<{ canonical_name: string; category: string; owner: string }>;
for (const en of ents) {
  console.log(`  ${en.canonical_name} (${en.category}, ${en.owner})`);
}

db.close();
