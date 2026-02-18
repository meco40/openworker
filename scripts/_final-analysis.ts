/**
 * Final comprehensive analysis of Lea's knowledge after ingestion
 */
import SqliteDatabase from 'better-sqlite3';

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const db = new SqliteDatabase('.local/messages.db', { readonly: true });

function parseJsonList(value: string): unknown[] {
  try {
    return JSON.parse(value) as unknown[];
  } catch {
    return [];
  }
}

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║       LEA KNOWLEDGE INGESTION — FINAL ANALYSIS              ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ── Overview ─────────────────────────────────────────────
const counts: Record<string, number> = {};
const tables = [
  'knowledge_episodes',
  'knowledge_entities',
  'knowledge_events',
  'knowledge_meeting_ledger',
  'knowledge_conversation_summaries',
];

for (const t of tables) {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM ${t} WHERE persona_id = ?`)
      .get(PERSONA_ID) as { c: number };
    counts[t] = row.c;
  } catch {
    counts[t] = -1;
  }
}

// Aliases and relations (no persona_id — count via entities)
try {
  const aliasCount = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM knowledge_entity_aliases 
    WHERE entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?)
  `,
    )
    .get(PERSONA_ID) as { c: number };
  counts['knowledge_entity_aliases'] = aliasCount.c;
} catch {
  counts['knowledge_entity_aliases'] = 0;
}

try {
  const relCount = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM knowledge_entity_relations 
    WHERE source_entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?)
       OR target_entity_id IN (SELECT id FROM knowledge_entities WHERE persona_id = ?)
  `,
    )
    .get(PERSONA_ID, PERSONA_ID) as { c: number };
  counts['knowledge_entity_relations'] = relCount.c;
} catch {
  counts['knowledge_entity_relations'] = 0;
}

console.log('=== ÜBERSICHT ===');
for (const [table, count] of Object.entries(counts)) {
  const short = table.replace('knowledge_', '');
  console.log(`  ${short.padEnd(30)} ${count}`);
}

// Checkpoint
const checkpoint = db
  .prepare('SELECT * FROM knowledge_ingestion_checkpoints WHERE persona_id = ?')
  .get(PERSONA_ID) as { last_seq: number; updated_at: string } | undefined;
console.log(
  `\n  checkpoint                   ${checkpoint ? `✓ lastSeq=${checkpoint.last_seq}` : '✗ MISSING'}`,
);

// ── Event Type Distribution ─────────────────────────────
console.log('\n=== EVENT TYPES (17 mögliche Kategorien) ===');
const eventTypes = db
  .prepare(
    'SELECT event_type, COUNT(*) as c FROM knowledge_events WHERE persona_id = ? GROUP BY event_type ORDER BY c DESC',
  )
  .all(PERSONA_ID) as Array<{ event_type: string; c: number }>;
const allTypes = [
  'shared_sleep',
  'visit',
  'trip',
  'meeting',
  'activity',
  'meal',
  'appointment',
  'celebration',
  'conflict',
  'reconciliation',
  'emotion',
  'location_change',
  'routine',
  'milestone',
  'relationship_change',
  'health',
  'finance',
];
const usedTypes = new Set(eventTypes.map((e) => e.event_type));
for (const et of eventTypes) {
  console.log(`  ${et.event_type.padEnd(25)} ${et.c}`);
}
const missing = allTypes.filter((t) => !usedTypes.has(t));
console.log(`\n  ✓ Genutzt: ${usedTypes.size}/${allTypes.length}`);
if (missing.length > 0) console.log(`  ✗ Fehlend: ${missing.join(', ')}`);

// ── Entity Categories ────────────────────────────────────
console.log('\n=== ENTITIES (nach Kategorie) ===');
const entityCats = db
  .prepare(
    'SELECT category, COUNT(*) as c FROM knowledge_entities WHERE persona_id = ? GROUP BY category ORDER BY c DESC',
  )
  .all(PERSONA_ID) as Array<{ category: string; c: number }>;
for (const ec of entityCats) {
  console.log(`  ${ec.category.padEnd(20)} ${ec.c}`);
}

// ── Top Entities ─────────────────────────────────────────
console.log('\n=== TOP ENTITIES ===');
const topEntities = db
  .prepare(
    'SELECT canonical_name, category, owner FROM knowledge_entities WHERE persona_id = ? ORDER BY canonical_name',
  )
  .all(PERSONA_ID) as Array<{ canonical_name: string; category: string; owner: string }>;
for (const e of topEntities) {
  console.log(`  ${e.canonical_name.padEnd(25)} ${e.category.padEnd(15)} owner=${e.owner}`);
}

// ── Aliases ──────────────────────────────────────────────
console.log('\n=== ENTITY ALIASES ===');
const aliases = db
  .prepare(
    `
  SELECT e.canonical_name, a.alias, a.alias_type 
  FROM knowledge_entity_aliases a
  JOIN knowledge_entities e ON a.entity_id = e.id
  WHERE e.persona_id = ?
  ORDER BY e.canonical_name, a.alias
`,
  )
  .all(PERSONA_ID) as Array<{ canonical_name: string; alias: string; alias_type: string }>;
const aliasMap = new Map<string, string[]>();
for (const a of aliases) {
  const list = aliasMap.get(a.canonical_name) || [];
  list.push(`${a.alias} (${a.alias_type})`);
  aliasMap.set(a.canonical_name, list);
}
for (const [name, aliasList] of aliasMap) {
  console.log(`  ${name}: ${aliasList.join(', ')}`);
}

// ── Relations ────────────────────────────────────────────
console.log('\n=== ENTITY RELATIONS ===');
const relations = db
  .prepare(
    `
  SELECT s.canonical_name as source, r.relation_type, t.canonical_name as target
  FROM knowledge_entity_relations r
  JOIN knowledge_entities s ON r.source_entity_id = s.id
  JOIN knowledge_entities t ON r.target_entity_id = t.id
  WHERE s.persona_id = ? OR t.persona_id = ?
  ORDER BY s.canonical_name
`,
  )
  .all(PERSONA_ID, PERSONA_ID) as Array<{ source: string; relation_type: string; target: string }>;
for (const r of relations) {
  console.log(`  ${r.source} --[${r.relation_type}]--> ${r.target}`);
}

// ── Sample Episode (first) ───────────────────────────────
console.log('\n=== SAMPLE EPISODE (erste) ===');
const firstEp = db
  .prepare(
    'SELECT topic_key, counterpart, teaser, facts_json FROM knowledge_episodes WHERE persona_id = ? ORDER BY created_at LIMIT 1',
  )
  .get(PERSONA_ID) as
  | { topic_key: string; counterpart: string | null; teaser: string; facts_json: string }
  | undefined;
if (firstEp) {
  console.log(`  topic: ${firstEp.topic_key}`);
  console.log(`  counterpart: ${firstEp.counterpart || '(none)'}`);
  console.log(`  teaser: ${firstEp.teaser.substring(0, 200)}...`);
  const facts = JSON.parse(firstEp.facts_json);
  console.log(`  facts (${facts.length}):`);
  for (const f of facts.slice(0, 5)) {
    console.log(`    • ${f}`);
  }
}

// ── Sample Meeting Ledger (with data) ────────────────────
console.log('\n=== SAMPLE MEETING LEDGER (mit Inhalt) ===');
const richLedger = db
  .prepare(
    `
  SELECT topic_key, counterpart, confidence, participants_json, decisions_json, 
         negotiated_terms_json, open_points_json, action_items_json
  FROM knowledge_meeting_ledger 
  WHERE persona_id = ? AND confidence > 0
  ORDER BY confidence DESC LIMIT 3
`,
  )
  .all(PERSONA_ID) as Array<{
  topic_key: string;
  counterpart: string | null;
  confidence: number;
  participants_json: string;
  decisions_json: string;
  negotiated_terms_json: string;
  open_points_json: string;
  action_items_json: string;
}>;
for (const l of richLedger) {
  console.log(`\n  topic: ${l.topic_key} (confidence=${l.confidence})`);
  console.log(`  counterpart: ${l.counterpart || '(none)'}`);
  const p = parseJsonList(l.participants_json);
  const d = parseJsonList(l.decisions_json);
  const n = parseJsonList(l.negotiated_terms_json);
  const o = parseJsonList(l.open_points_json);
  const a = parseJsonList(l.action_items_json);
  if (p.length) console.log(`  participants: ${p.join(', ')}`);
  if (d.length) console.log(`  decisions: ${d.join('; ')}`);
  if (n.length) console.log(`  negotiated_terms: ${n.join('; ')}`);
  if (o.length) console.log(`  open_points: ${o.join('; ')}`);
  if (a.length) console.log(`  action_items: ${a.join('; ')}`);
}

// ── Persona Type Check ───────────────────────────────────
console.log('\n=== PERSONA TYPE ===');
const personaDb = new SqliteDatabase('.local/personas.db', { readonly: true });
try {
  const persona = personaDb
    .prepare('SELECT name, memory_persona_type FROM personas WHERE id = ?')
    .get(PERSONA_ID) as { name: string; memory_persona_type: string } | undefined;
  if (persona) {
    console.log(`  Name: ${persona.name}`);
    console.log(`  memory_persona_type: ${persona.memory_persona_type}`);
    console.log(`  → Effektiv genutzt in retrievalService für Ranking-Score-Adjustment`);
  }
} catch {
  console.log('  ✗ Konnte Personas-DB nicht lesen');
}
personaDb.close();

db.close();

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(' ANALYSE ABGESCHLOSSEN');
console.log('═══════════════════════════════════════════════════════════════');
