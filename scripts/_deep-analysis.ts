/**
 * Deep analysis of Lea's ingestion results
 */
import SqliteDatabase from 'better-sqlite3';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });

// Check episode schema
const episodeCols = db.prepare('PRAGMA table_info(knowledge_episodes)').all() as { name: string }[];
console.log('Episode columns:', episodeCols.map((c) => c.name).join(', '));

// Sample episodes
const episodes = db
  .prepare('SELECT * FROM knowledge_episodes WHERE persona_id = ? LIMIT 3')
  .all(PERSONA_ID);
console.log('\n=== Sample Episodes (3 of 12) ===');
for (const ep of episodes) {
  console.log(JSON.stringify(ep, null, 2));
  console.log('---');
}

// Sample events
const events = db
  .prepare('SELECT * FROM knowledge_events WHERE persona_id = ? LIMIT 5')
  .all(PERSONA_ID);
console.log('\n=== Sample Events (5 of 33) ===');
for (const ev of events) {
  console.log(JSON.stringify(ev, null, 2));
}

// Event type distribution
const eventTypes = db
  .prepare(
    'SELECT event_type, COUNT(*) as c FROM knowledge_events WHERE persona_id = ? GROUP BY event_type ORDER BY c DESC',
  )
  .all(PERSONA_ID);
console.log('\n=== Event Types ===');
for (const et of eventTypes) {
  console.log(JSON.stringify(et));
}

// Meeting ledger sample
const ledger = db
  .prepare('SELECT * FROM knowledge_meeting_ledger WHERE persona_id = ? LIMIT 3')
  .all(PERSONA_ID);
console.log('\n=== Sample Meeting Ledger (3 of 12) ===');
for (const l of ledger) {
  console.log(JSON.stringify(l, null, 2));
}

// Entity schema and any data
const entityCols = db.prepare('PRAGMA table_info(knowledge_entities)').all() as { name: string }[];
console.log('\nEntity columns:', entityCols.map((c) => c.name).join(', '));
const allEntities = db.prepare('SELECT * FROM knowledge_entities LIMIT 5').all();
console.log('All entities (any persona):', allEntities.length);

// Check checkpoint
const allCheckpoints = db.prepare('SELECT * FROM knowledge_ingestion_checkpoints').all();
console.log('\n=== All Checkpoints ===');
for (const cp of allCheckpoints) {
  console.log(JSON.stringify(cp, null, 2));
}

// Check conversation summaries schema
try {
  const sumCols = db.prepare('PRAGMA table_info(knowledge_conversation_summaries)').all() as {
    name: string;
  }[];
  console.log('\nConversation summaries columns:', sumCols.map((c) => c.name).join(', '));
} catch {
  /* ignore */
}

db.close();
