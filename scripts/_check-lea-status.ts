/**
 * Quick check of Lea's knowledge data status after ingestion
 */
import SqliteDatabase from 'better-sqlite3';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';

const db = new SqliteDatabase('.local/messages.db', { readonly: true });

// Discover which knowledge tables exist
const allTables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%' ORDER BY name",
  )
  .all() as { name: string }[];
console.log('Knowledge tables:', allTables.map((t) => t.name).join(', '));

const tables = allTables
  .filter((t) => !['knowledge_ingestion_checkpoints'].includes(t.name))
  .map((t) => t.name);

console.log('=== Lea Knowledge Status ===\n');

for (const t of tables) {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM ${t} WHERE persona_id = ?`)
      .get(PERSONA_ID) as { c: number };
    console.log(`${t}: ${row.c}`);
  } catch {
    // table might not have persona_id column
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
      console.log(`${t}: ${row.c} (no persona_id)`);
    } catch (e2) {
      console.log(`${t}: ERROR - ${e2}`);
    }
  }
}

// Check checkpoint
const checkpoint = db
  .prepare('SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id = ?')
  .get(PERSONA_ID);
console.log('\nCheckpoint:', JSON.stringify(checkpoint, null, 2));

// Sample episodes if any
const episodes = db
  .prepare(
    'SELECT id, title, confidence, message_count, created_at FROM knowledge_episodes WHERE persona_id = ? ORDER BY created_at LIMIT 5',
  )
  .all(PERSONA_ID);
if (episodes.length > 0) {
  console.log('\nSample episodes:');
  for (const ep of episodes) {
    console.log(`  ${JSON.stringify(ep)}`);
  }
}

// Sample entities if any
const entities = db
  .prepare(
    'SELECT id, canonical_name, category FROM knowledge_entities WHERE persona_id = ? LIMIT 10',
  )
  .all(PERSONA_ID);
if (entities.length > 0) {
  console.log('\nSample entities:');
  for (const e of entities) {
    console.log(`  ${JSON.stringify(e)}`);
  }
}

// Sample facts if any
try {
  const facts = db
    .prepare(
      'SELECT id, subject, predicate, object FROM knowledge_facts WHERE persona_id = ? LIMIT 10',
    )
    .all(PERSONA_ID);
  if (facts.length > 0) {
    console.log('\nSample facts:');
    for (const f of facts) {
      console.log(`  ${JSON.stringify(f)}`);
    }
  }
} catch {
  console.log('\nknowledge_facts: table not found');
}

// Sample events if any
const events = db
  .prepare(
    'SELECT id, event_type, title, event_date FROM knowledge_events WHERE persona_id = ? LIMIT 10',
  )
  .all(PERSONA_ID);
if (events.length > 0) {
  console.log('\nSample events:');
  for (const ev of events) {
    console.log(`  ${JSON.stringify(ev)}`);
  }
}

db.close();
