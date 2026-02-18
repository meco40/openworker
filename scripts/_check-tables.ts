import SqliteDatabase from 'better-sqlite3';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });
const pid = '48979798-6783-4ae2-895b-1d0222b2af26';
const cid = '8c010a84-74b8-4c9d-beb7-b93cfef673e7';

console.log('=== CHECKPOINT ===');
console.log(
  db.prepare(`SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id=?`).all(pid),
);

console.log('');
console.log('=== EPISODES ===');
const eps = db
  .prepare(
    `SELECT source_seq_start, source_seq_end, teaser FROM knowledge_episodes WHERE persona_id=? ORDER BY source_seq_start`,
  )
  .all(pid);
for (const e of eps as Array<{
  source_seq_start: number;
  source_seq_end: number;
  teaser: string;
}>) {
  console.log(`  [${e.source_seq_start}-${e.source_seq_end}] ${e.teaser.substring(0, 100)}`);
}

console.log('');
console.log('=== EVENTS ===');
const evts = db
  .prepare(
    `SELECT event_type, speaker_role, subject_entity, counterpart_entity, source_summary FROM knowledge_events WHERE persona_id=?`,
  )
  .all(pid);
for (const e of evts as Array<{
  event_type: string;
  speaker_role: string;
  subject_entity: string;
  counterpart_entity: string;
  source_summary: string;
}>) {
  console.log(
    `  ${e.event_type}: subj=${e.subject_entity} counter=${e.counterpart_entity} speaker=${e.speaker_role} | ${e.source_summary.substring(0, 80)}`,
  );
}

console.log('');
console.log('=== ALIASES ===');
const als = db
  .prepare(
    `SELECT e.canonical_name, a.alias, a.alias_type FROM knowledge_entity_aliases a JOIN knowledge_entities e ON e.id=a.entity_id WHERE e.persona_id=?`,
  )
  .all(pid);
for (const a of als as Array<{ canonical_name: string; alias: string; alias_type: string }>) {
  console.log(`  ${a.canonical_name}: "${a.alias}" (${a.alias_type})`);
}

console.log('');
console.log('=== TOTAL MESSAGES ===');
console.log(
  db
    .prepare(`SELECT count(*) as c, max(seq) as max_seq FROM messages WHERE conversation_id=?`)
    .get(cid),
);

db.close();
