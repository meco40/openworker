import SqliteDatabase from 'better-sqlite3';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });

// Raw counts without any filters
const tables = [
  'knowledge_episodes',
  'knowledge_entities',
  'knowledge_events',
  'knowledge_meeting_ledger',
];
console.log('=== Raw counts (no filter) ===');
for (const t of tables) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
  console.log(`  ${t}: ${row.c}`);
}

// Check ALL episodes
console.log('\n=== All episodes ===');
const episodes = db
  .prepare(
    'SELECT id, user_id, persona_id, topic_key, source_seq_start, source_seq_end FROM knowledge_episodes LIMIT 5',
  )
  .all();
for (const ep of episodes) {
  console.log(JSON.stringify(ep));
}

// Check ALL events
console.log('\n=== All events (sample) ===');
const events = db.prepare('SELECT id, persona_id, event_type FROM knowledge_events LIMIT 5').all();
for (const ev of events) {
  console.log(JSON.stringify(ev));
}

// Check ALL checkpoints
console.log('\n=== All checkpoints ===');
const checkpoints = db.prepare('SELECT * FROM knowledge_ingestion_checkpoints').all();
for (const cp of checkpoints) {
  console.log(JSON.stringify(cp));
}

// Check if maybe data is in a different DB file
console.log('\n=== DB file info ===');
console.log('DB path:', '.local/messages.db');
import fs from 'node:fs';
const stats = fs.statSync('.local/messages.db');
console.log('DB size:', Math.round(stats.size / 1024), 'KB');
console.log('DB modified:', stats.mtime.toISOString());

db.close();
