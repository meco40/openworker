import SqliteDatabase from 'better-sqlite3';

const LEA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });

// ── Episodes ─────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════');
console.log('  KNOWLEDGE INGESTION RESULTS FOR LEA');
console.log('═══════════════════════════════════════════');

const episodes = db
  .prepare(`SELECT * FROM knowledge_episodes WHERE persona_id = ? ORDER BY created_at`)
  .all(LEA_ID) as Array<Record<string, unknown>>;
console.log(`\n📖 EPISODES: ${episodes.length}`);
for (const ep of episodes) {
  const content = String(ep.content || '');
  console.log(`\n  [${ep.id}]`);
  console.log(`    topic: ${ep.topic_key}`);
  console.log(`    counterpart: ${ep.counterpart}`);
  console.log(`    teaser: ${ep.teaser}`);
  console.log(`    event_at: ${ep.event_at}`);
  console.log(`    created: ${ep.created_at}`);
  console.log(`    episode (first 500 chars): ${content.substring(0, 500)}...`);
  if (ep.facts_json) {
    try {
      const facts = JSON.parse(String(ep.facts_json));
      console.log(`    facts (${facts.length}):`);
      for (const f of facts.slice(0, 10))
        console.log(`      • ${typeof f === 'string' ? f : JSON.stringify(f)}`);
      if (facts.length > 10) console.log(`      ... and ${facts.length - 10} more`);
    } catch {
      console.log(`    facts_json: ${String(ep.facts_json).substring(0, 200)}`);
    }
  }
}

// ── Entities ─────────────────────────────────────────────
const entities = db
  .prepare(
    `SELECT * FROM knowledge_entities WHERE persona_id = ? ORDER BY category, canonical_name`,
  )
  .all(LEA_ID) as Array<Record<string, unknown>>;
console.log(`\n\n👤 ENTITIES: ${entities.length}`);
for (const ent of entities) {
  const props = ent.properties_json ? JSON.parse(String(ent.properties_json)) : {};
  console.log(
    `  [${ent.category}] ${ent.canonical_name} (owner: ${ent.owner}) — ${JSON.stringify(props).substring(0, 120)}`,
  );
}

// ── Entity Aliases ───────────────────────────────────────
const entityIds = entities.map((e) => `'${e.id}'`).join(',');
if (entityIds) {
  const aliases = db
    .prepare(
      `SELECT ea.*, ke.canonical_name as entity_name FROM knowledge_entity_aliases ea JOIN knowledge_entities ke ON ea.entity_id = ke.id WHERE ea.entity_id IN (${entityIds}) ORDER BY ea.entity_id`,
    )
    .all() as Array<Record<string, unknown>>;
  console.log(`\n\n🏷️  ENTITY ALIASES: ${aliases.length}`);
  for (const a of aliases) {
    console.log(
      `  ${a.entity_name} → alias: "${a.alias}" (type: ${a.alias_type}, confidence: ${a.confidence})`,
    );
  }
}

// ── Events ───────────────────────────────────────────────
const events = db
  .prepare(`SELECT * FROM knowledge_events WHERE persona_id = ? ORDER BY start_date, event_type`)
  .all(LEA_ID) as Array<Record<string, unknown>>;
console.log(`\n\n📅 EVENTS: ${events.length}`);
for (const ev of events) {
  console.log(
    `  [${ev.event_type}] ${ev.start_date || 'no date'}${ev.end_date ? ' → ' + ev.end_date : ''} — ${ev.source_summary || ''}`,
  );
  if (ev.subject_entity) console.log(`    subject: ${ev.subject_entity}`);
  if (ev.counterpart_entity) console.log(`    counterpart: ${ev.counterpart_entity}`);
  if (ev.relation_label) console.log(`    relation: ${ev.relation_label}`);
  console.log(`    confidence: ${ev.confidence}  speaker: ${ev.speaker_role}/${ev.speaker_entity}`);
}

// ── Meeting Ledger ───────────────────────────────────────
const ledger = db
  .prepare(`SELECT * FROM knowledge_meeting_ledger WHERE persona_id = ? ORDER BY created_at`)
  .all(LEA_ID) as Array<Record<string, unknown>>;
console.log(`\n\n📋 MEETING LEDGER: ${ledger.length}`);
for (const entry of ledger) {
  console.log(`\n  [${entry.id}]`);
  console.log(`    topic: ${entry.topic_key}`);
  console.log(`    counterpart: ${entry.counterpart}`);
  console.log(`    event_at: ${entry.event_at}`);
  console.log(`    confidence: ${entry.confidence}`);
  console.log(`    created: ${entry.created_at}`);
  const jsonFields = [
    'participants_json',
    'decisions_json',
    'negotiated_terms_json',
    'open_points_json',
    'action_items_json',
  ];
  for (const field of jsonFields) {
    if (entry[field]) {
      try {
        const arr = JSON.parse(String(entry[field]));
        if (arr.length > 0) console.log(`    ${field}: ${JSON.stringify(arr).substring(0, 200)}`);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Ingestion Checkpoints ────────────────────────────────
const checkpoints = db
  .prepare(`SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id = ?`)
  .all(LEA_ID) as Array<Record<string, unknown>>;
console.log(`\n\n🔖 INGESTION CHECKPOINTS: ${checkpoints.length}`);
for (const cp of checkpoints) {
  console.log(
    `  conversation: ${cp.conversation_id}  last_seq: ${cp.last_seq}  updated: ${cp.updated_at}`,
  );
}

// ── Event Type Distribution ──────────────────────────────
if (events.length > 0) {
  const typeDist = db
    .prepare(
      `SELECT event_type, COUNT(*) as cnt FROM knowledge_events WHERE persona_id = ? GROUP BY event_type ORDER BY cnt DESC`,
    )
    .all(LEA_ID) as Array<{ event_type: string; cnt: number }>;
  console.log('\n\n📊 EVENT TYPE DISTRIBUTION:');
  for (const t of typeDist) {
    console.log(`  ${t.event_type}: ${t.cnt}`);
  }
}

// ── Entity Type Distribution ─────────────────────────────
if (entities.length > 0) {
  const entDist = db
    .prepare(
      `SELECT category, COUNT(*) as cnt FROM knowledge_entities WHERE persona_id = ? GROUP BY category ORDER BY cnt DESC`,
    )
    .all(LEA_ID) as Array<{ category: string; cnt: number }>;
  console.log('\n\n📊 ENTITY CATEGORY DISTRIBUTION:');
  for (const t of entDist) {
    console.log(`  ${t.category}: ${t.cnt}`);
  }
}

// ── Conversation Summaries ───────────────────────────────
try {
  const summaries = db
    .prepare(`SELECT * FROM knowledge_conversation_summaries WHERE persona_id = ?`)
    .all(LEA_ID) as Array<Record<string, unknown>>;
  console.log(`\n\n📝 CONVERSATION SUMMARIES: ${summaries.length}`);
  for (const s of summaries) {
    console.log(`  [${s.id}] conv=${s.conversation_id} type=${s.summary_type}`);
    console.log(`    ${String(s.content || '').substring(0, 200)}...`);
  }
} catch {
  console.log('\n\n📝 CONVERSATION SUMMARIES: table not found');
}

// ── Mem0 check ───────────────────────────────────────────
console.log('\n\n💾 Note: Mem0 memories are stored externally. Check via Mem0 API.');
console.log('\n═══════════════════════════════════════════');

db.close();
