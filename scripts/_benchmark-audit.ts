/**
 * Knowledge Benchmark Audit — v2
 * Analyzes data quality of extracted knowledge against ground truth.
 * Run: npx tsx scripts/_benchmark-audit.ts
 *
 * Schema reference:
 *   knowledge_entities:          canonical_name, category, owner
 *   knowledge_entity_aliases:    entity_id, alias, alias_type, owner
 *   knowledge_events:            event_type, speaker_role, speaker_entity, subject_entity, counterpart_entity, relation_label, source_summary
 *   knowledge_meeting_ledger:    topic_key, counterpart, participants_json, decisions_json, action_items_json
 *   knowledge_entity_relations:  source_entity_id, target_entity_id, relation_type
 *   knowledge_episodes:          topic_key, counterpart, teaser, episode, facts_json, source_seq_start, source_seq_end
 */

import SqliteDatabase from 'better-sqlite3';
import path from 'node:path';

const messagesDb = new SqliteDatabase(path.join('.local', 'messages.db'), { readonly: true });

const PERSONA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const CONV_ID = '8c010a84-74b8-4c9d-beb7-b93cfef673e7';

// ─── GROUND TRUTH ────────────────────────────────────────────────
// Lea (persona/assistant) mentions: Sabine (Mutter), Jonas (Bruder), Thomas (Vater), Paul (Ex-Freund)
// Meco (user) mentions: Leni (Tochter), Helga (Mutter), Daniel (Bruder), Mira (Partnerin), Niko (alter Freund)

interface GroundTruthEntity {
  name: string;
  expectedOwner: 'persona' | 'user' | 'shared';
  expectedAliases: string[];
  belongsTo: 'Lea' | 'Meco' | 'shared';
  relationship: string;
}

const GROUND_TRUTH_ENTITIES: GroundTruthEntity[] = [
  {
    name: 'Lea',
    expectedOwner: 'persona',
    expectedAliases: [],
    belongsTo: 'Lea',
    relationship: 'self (persona)',
  },
  {
    name: 'Meco',
    expectedOwner: 'user',
    expectedAliases: [],
    belongsTo: 'Meco',
    relationship: 'self (user)',
  },
  // Lea's people -> owner=persona
  {
    name: 'Sabine',
    expectedOwner: 'persona',
    expectedAliases: ['Mutter', 'mama'],
    belongsTo: 'Lea',
    relationship: 'Leas Mutter',
  },
  {
    name: 'Jonas',
    expectedOwner: 'persona',
    expectedAliases: ['Bruder'],
    belongsTo: 'Lea',
    relationship: 'Leas Bruder',
  },
  {
    name: 'Thomas',
    expectedOwner: 'persona',
    expectedAliases: ['Vater'],
    belongsTo: 'Lea',
    relationship: 'Leas Vater',
  },
  {
    name: 'Paul',
    expectedOwner: 'persona',
    expectedAliases: ['Ex-Freund', 'Ex'],
    belongsTo: 'Lea',
    relationship: 'Leas Ex-Freund',
  },
  // Meco's people -> owner=user
  {
    name: 'Leni',
    expectedOwner: 'user',
    expectedAliases: ['Tochter'],
    belongsTo: 'Meco',
    relationship: 'Mecos Tochter',
  },
  {
    name: 'Helga',
    expectedOwner: 'user',
    expectedAliases: ['Mutter', 'mama'],
    belongsTo: 'Meco',
    relationship: 'Mecos Mutter',
  },
  {
    name: 'Daniel',
    expectedOwner: 'user',
    expectedAliases: ['Bruder'],
    belongsTo: 'Meco',
    relationship: 'Mecos Bruder',
  },
  {
    name: 'Mira',
    expectedOwner: 'user',
    expectedAliases: ['Partnerin'],
    belongsTo: 'Meco',
    relationship: 'Mecos Partnerin',
  },
  {
    name: 'Niko',
    expectedOwner: 'user',
    expectedAliases: ['Freund'],
    belongsTo: 'Meco',
    relationship: 'Mecos alter Freund',
  },
  // Shared entities
  {
    name: 'Hamburg',
    expectedOwner: 'shared',
    expectedAliases: [],
    belongsTo: 'shared',
    relationship: 'Ort',
  },
];

// ─── AUDIT: ENTITIES ─────────────────────────────────────────────

function auditEntities() {
  const details: string[] = [];
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  let extra = 0;

  const dbEntities = messagesDb
    .prepare(
      `
    SELECT e.canonical_name, e.owner, e.category,
           GROUP_CONCAT(a.alias, ', ') as aliases
    FROM knowledge_entities e
    LEFT JOIN knowledge_entity_aliases a ON a.entity_id = e.id
    WHERE e.persona_id = ?
    GROUP BY e.id
    ORDER BY e.canonical_name
  `,
    )
    .all(PERSONA_ID) as Array<{
    canonical_name: string;
    owner: string;
    category: string;
    aliases: string | null;
  }>;

  const dbEntityMap = new Map(dbEntities.map((e) => [e.canonical_name.toLowerCase(), e]));

  for (const gt of GROUND_TRUTH_ENTITIES) {
    const found = dbEntityMap.get(gt.name.toLowerCase());
    if (!found) {
      missing++;
      details.push(
        `  MISSING: ${gt.name} (erwartet owner=${gt.expectedOwner}, ${gt.relationship})`,
      );
      continue;
    }

    if (found.owner === gt.expectedOwner) {
      correct++;
      details.push(
        `  OK  ${gt.name}: owner=${found.owner} cat=${found.category} (${gt.relationship})`,
      );
    } else {
      wrong++;
      details.push(
        `  ERR ${gt.name}: owner=${found.owner} statt ${gt.expectedOwner} (${gt.relationship})`,
      );
    }

    // Check aliases
    const dbAliases = (found.aliases || '')
      .split(', ')
      .filter(Boolean)
      .map((a) => a.toLowerCase());
    for (const expectedAlias of gt.expectedAliases) {
      if (!dbAliases.some((a) => a.includes(expectedAlias.toLowerCase()))) {
        details.push(`       alias fehlt: "${expectedAlias}" nicht in [${dbAliases.join(', ')}]`);
      }
    }
  }

  // Check for unexpected entities not in ground truth
  const gtNames = new Set(GROUND_TRUTH_ENTITIES.map((g) => g.name.toLowerCase()));
  for (const [name, entity] of dbEntityMap) {
    if (!gtNames.has(name)) {
      extra++;
      details.push(
        `  EXTRA: ${entity.canonical_name} (owner=${entity.owner}, cat=${entity.category}, aliases=${entity.aliases || '-'})`,
      );
    }
  }

  return { correct, wrong, missing, extra, details };
}

// ─── AUDIT: EVENTS ───────────────────────────────────────────────

function auditEvents() {
  const details: string[] = [];
  let correct = 0;
  let wrong = 0;
  let ambiguous = 0;

  const events = messagesDb
    .prepare(
      `
    SELECT event_type, speaker_role, speaker_entity, subject_entity, counterpart_entity,
           relation_label, source_summary, confidence
    FROM knowledge_events
    WHERE persona_id = ?
    ORDER BY event_type
  `,
    )
    .all(PERSONA_ID) as Array<{
    event_type: string;
    speaker_role: string;
    speaker_entity: string;
    subject_entity: string;
    counterpart_entity: string;
    relation_label: string | null;
    source_summary: string;
    confidence: number;
  }>;

  // Lea's world pattern
  const leaPattern = /\bSabine\b|\bJonas\b|\bThomas\b|\bPaul\b/i;
  // Meco's world pattern
  const mecoPattern = /\bLeni\b|\bHelga\b|\bDaniel\b|\bMira\b|\bNiko\b/i;

  for (const evt of events) {
    // Resolve UUID-based subjects to "Lea" for pattern matching
    const resolvedSubject = evt.subject_entity === PERSONA_ID ? 'Lea' : evt.subject_entity;
    const resolvedCounterpart =
      evt.counterpart_entity === PERSONA_ID ? 'Lea' : evt.counterpart_entity;
    const combined = [resolvedSubject, resolvedCounterpart, evt.relation_label || ''].join(' ');
    const involvesLeaPeople = leaPattern.test(combined);
    const involvesMecoPeople = mecoPattern.test(combined);

    if (involvesLeaPeople && !involvesMecoPeople) {
      if (evt.speaker_role === 'assistant') {
        correct++;
        details.push(
          `  OK  ${evt.event_type}: ${evt.subject_entity} + ${evt.counterpart_entity} -> speaker=${evt.speaker_role}`,
        );
      } else {
        wrong++;
        details.push(
          `  ERR ${evt.event_type}: ${evt.subject_entity} + ${evt.counterpart_entity} -> speaker=${evt.speaker_role} statt assistant (Leas Welt)`,
        );
      }
    } else if (involvesMecoPeople && !involvesLeaPeople) {
      if (evt.speaker_role === 'user') {
        correct++;
        details.push(
          `  OK  ${evt.event_type}: ${evt.subject_entity} + ${evt.counterpart_entity} -> speaker=${evt.speaker_role}`,
        );
      } else {
        wrong++;
        details.push(
          `  ERR ${evt.event_type}: ${evt.subject_entity} + ${evt.counterpart_entity} -> speaker=${evt.speaker_role} statt user (Mecos Welt)`,
        );
      }
    } else {
      ambiguous++;
      details.push(
        `  ???  ${evt.event_type}: ${evt.subject_entity} + ${evt.counterpart_entity} -> speaker=${evt.speaker_role} (nicht zuordenbar)`,
      );
    }
  }

  return { correct, wrong, ambiguous, details };
}

// ─── AUDIT: RELATIONS ────────────────────────────────────────────

function auditRelations() {
  const details: string[] = [];
  let correct = 0;
  let wrong = 0;

  const relations = messagesDb
    .prepare(
      `
    SELECT s.canonical_name as source_name, t.canonical_name as target_name, r.relation_type
    FROM knowledge_entity_relations r
    JOIN knowledge_entities s ON s.id = r.source_entity_id
    JOIN knowledge_entities t ON t.id = r.target_entity_id
    WHERE s.persona_id = ?
    ORDER BY s.canonical_name
  `,
    )
    .all(PERSONA_ID) as Array<{ source_name: string; target_name: string; relation_type: string }>;

  // Build alias → canonical_name map for fuzzy matching
  const aliasToCanonical = new Map<string, string>();
  const entityRows = messagesDb
    .prepare(
      `SELECT e.canonical_name, a.alias
       FROM knowledge_entities e
       LEFT JOIN knowledge_entity_aliases a ON a.entity_id = e.id
       WHERE e.persona_id = ?`,
    )
    .all(PERSONA_ID) as Array<{ canonical_name: string; alias: string | null }>;
  for (const row of entityRows) {
    aliasToCanonical.set(row.canonical_name.toLowerCase(), row.canonical_name);
    if (row.alias) aliasToCanonical.set(row.alias.toLowerCase(), row.canonical_name);
  }

  const expectedRelations = [
    { source: 'Sabine', target: 'Lea', desc: 'Sabine -> Lea (Mutter-Tochter)' },
    { source: 'Jonas', target: 'Lea', desc: 'Jonas -> Lea (Geschwister)' },
    { source: 'Thomas', target: 'Lea', desc: 'Thomas -> Lea (Vater-Tochter)' },
    { source: 'Paul', target: 'Lea', desc: 'Paul -> Lea (Ex-Partner)' },
    { source: 'Meco', target: 'Mira', desc: 'Meco -> Mira (Partner)' },
  ];

  // Resolve relation names through aliases for matching
  const resolvedRelations = relations.map((r) => ({
    ...r,
    resolved_source: aliasToCanonical.get(r.source_name.toLowerCase()) || r.source_name,
    resolved_target: aliasToCanonical.get(r.target_name.toLowerCase()) || r.target_name,
  }));

  details.push('  Gefunden:');
  for (const r of relations) {
    details.push(`    ${r.source_name} -> ${r.target_name} (${r.relation_type})`);
  }
  details.push('');
  details.push('  Erwartet:');
  for (const er of expectedRelations) {
    const found = resolvedRelations.some(
      (r) =>
        (r.resolved_source.toLowerCase().includes(er.source.toLowerCase()) ||
          r.source_name.toLowerCase().includes(er.source.toLowerCase())) &&
        (r.resolved_target.toLowerCase().includes(er.target.toLowerCase()) ||
          r.target_name.toLowerCase().includes(er.target.toLowerCase())),
    );
    if (found) {
      correct++;
      details.push(`    OK  ${er.desc}`);
    } else {
      wrong++;
      details.push(`    ERR ${er.desc} -- NICHT GEFUNDEN`);
    }
  }

  return { correct, wrong, details };
}

// ─── AUDIT: MEETING LEDGER ───────────────────────────────────────

function auditLedger() {
  const details: string[] = [];

  const ledger = messagesDb
    .prepare(
      `
    SELECT topic_key, counterpart, event_at, participants_json, decisions_json,
           action_items_json, open_points_json, confidence
    FROM knowledge_meeting_ledger
    WHERE persona_id = ?
    ORDER BY topic_key
  `,
    )
    .all(PERSONA_ID) as Array<{
    topic_key: string;
    counterpart: string | null;
    event_at: string | null;
    participants_json: string;
    decisions_json: string;
    action_items_json: string;
    open_points_json: string;
    confidence: number;
  }>;

  details.push(`  ${ledger.length} Ledger-Eintraege:`);
  for (const l of ledger) {
    const participants = JSON.parse(l.participants_json || '[]');
    const decisions = JSON.parse(l.decisions_json || '[]');
    const actions = JSON.parse(l.action_items_json || '[]');
    details.push(
      `    topic=${l.topic_key} counter=${l.counterpart || '-'} date=${l.event_at || '-'} participants=${participants.length} decisions=${decisions.length} actions=${actions.length} conf=${l.confidence}`,
    );
  }

  return { details };
}

// ─── AUDIT: EPISODES ─────────────────────────────────────────────

function auditEpisodes() {
  const details: string[] = [];

  const episodes = messagesDb
    .prepare(
      `
    SELECT id, topic_key, counterpart, teaser, source_seq_start, source_seq_end,
           facts_json
    FROM knowledge_episodes
    WHERE persona_id = ?
    ORDER BY source_seq_start
  `,
    )
    .all(PERSONA_ID) as Array<{
    id: string;
    topic_key: string;
    counterpart: string | null;
    teaser: string;
    source_seq_start: number;
    source_seq_end: number;
    facts_json: string;
  }>;

  details.push(`  ${episodes.length} Episoden:`);
  let totalFacts = 0;
  for (const ep of episodes) {
    const facts = JSON.parse(ep.facts_json || '[]');
    totalFacts += facts.length;
    details.push(
      `    [${ep.source_seq_start}-${ep.source_seq_end}] ${ep.topic_key} | ${ep.teaser.substring(0, 80)}...`,
    );
    details.push(`      facts=${facts.length}, counterpart=${ep.counterpart || '-'}`);
  }
  details.push(`  Total facts: ${totalFacts}`);

  return { details };
}

// ─── AUDIT: MESSAGE CROSS-CHECK ──────────────────────────────────

function crossCheckMessages() {
  const details: string[] = [];

  const msgs = messagesDb
    .prepare(
      `
    SELECT seq, role, content
    FROM messages
    WHERE conversation_id = ?
    ORDER BY seq
  `,
    )
    .all(CONV_ID) as Array<{ seq: number; role: string; content: string }>;

  const leaPattern = /\bSabine\b|\bJonas\b|\bThomas\b|\bPaul\b/i;
  const mecoPattern = /\bLeni\b|\bHelga\b|\bDaniel\b|\bMira\b|\bNiko\b/i;

  let correctMentions = 0;
  let crossMentions = 0;
  const anomalies: string[] = [];

  for (const m of msgs) {
    const text = m.content;
    if (leaPattern.test(text)) {
      if (m.role === 'assistant') {
        correctMentions++;
      } else {
        crossMentions++;
        anomalies.push(`  [${m.seq}] ${m.role} erwaehnt Lea-Person: ${text.substring(0, 100)}`);
      }
    }
    if (mecoPattern.test(text)) {
      if (m.role === 'user') {
        correctMentions++;
      } else {
        crossMentions++;
        anomalies.push(`  [${m.seq}] ${m.role} erwaehnt Meco-Person: ${text.substring(0, 100)}`);
      }
    }
  }

  details.push(`  Nachrichten-Analyse (${msgs.length} messages):`);
  details.push(`    Korrekte Zuordnung (Sprecher=Besitzer): ${correctMentions}`);
  details.push(`    Cross-Referenzen (Sprecher erwaehnt andere Welt): ${crossMentions}`);
  details.push('');
  if (anomalies.length > 0) {
    details.push('  Cross-Referenzen (normal bei Gespraech!):');
    for (const a of anomalies.slice(0, 20)) details.push(`    ${a}`);
    if (anomalies.length > 20) details.push(`    ... und ${anomalies.length - 20} weitere`);
  }

  return { details };
}

// ─── MAIN ────────────────────────────────────────────────────────

// Ingestion progress
const checkpoint = messagesDb
  .prepare(
    `SELECT last_seq FROM knowledge_ingestion_checkpoints WHERE persona_id = ? AND conversation_id = ?`,
  )
  .get(PERSONA_ID, CONV_ID) as { last_seq: number } | undefined;
const maxSeq = messagesDb
  .prepare(`SELECT max(seq) as m FROM messages WHERE conversation_id = ?`)
  .get(CONV_ID) as { m: number };

console.log('');
console.log('================================================================');
console.log('    KNOWLEDGE BENCHMARK -- Data Quality Audit');
console.log('    Persona: Lea');
console.log('    Conversation: ' + CONV_ID);
console.log(`    Ingestion: ${checkpoint?.last_seq ?? 0}/${maxSeq.m} messages processed`);
console.log('================================================================');
console.log('');

// 1. Entity Audit
console.log('--- 1. ENTITY OWNER ATTRIBUTION ---');
const entityResult = auditEntities();
console.log(`  Korrekt: ${entityResult.correct}/${GROUND_TRUTH_ENTITIES.length}`);
console.log(`  Falsch: ${entityResult.wrong}`);
console.log(`  Fehlend: ${entityResult.missing}`);
console.log(`  Extra: ${entityResult.extra}`);
console.log('');
for (const d of entityResult.details) console.log(d);
console.log('');

// 2. Event Speaker Audit
console.log('--- 2. EVENT SPEAKER ATTRIBUTION ---');
const eventResult = auditEvents();
console.log(`  Korrekt: ${eventResult.correct}`);
console.log(`  Falsch: ${eventResult.wrong}`);
console.log(`  Nicht zuordenbar: ${eventResult.ambiguous}`);
console.log('');
for (const d of eventResult.details) console.log(d);
console.log('');

// 3. Relation Audit
console.log('--- 3. RELATIONEN ---');
const relationResult = auditRelations();
console.log(
  `  Korrekt: ${relationResult.correct}/${relationResult.correct + relationResult.wrong}`,
);
console.log('');
for (const d of relationResult.details) console.log(d);
console.log('');

// 4. Meeting Ledger
console.log('--- 4. MEETING LEDGER ---');
const ledgerResult = auditLedger();
for (const d of ledgerResult.details) console.log(d);
console.log('');

// 5. Episodes
console.log('--- 5. EPISODEN ---');
const episodeResult = auditEpisodes();
for (const d of episodeResult.details) console.log(d);
console.log('');

// 6. Cross-check messages
console.log('--- 6. MESSAGE CROSS-CHECK ---');
const crossResult = crossCheckMessages();
for (const d of crossResult.details) console.log(d);
console.log('');

// ─── SUMMARY ─────────────────────────────────────────────────────
const totalChecked =
  entityResult.correct +
  entityResult.wrong +
  eventResult.correct +
  eventResult.wrong +
  relationResult.correct +
  relationResult.wrong;
const totalCorrect = entityResult.correct + eventResult.correct + relationResult.correct;
const score = totalChecked > 0 ? Math.round((totalCorrect / totalChecked) * 100) : 0;

console.log('================================================================');
console.log('    GESAMTERGEBNIS');
console.log('================================================================');
console.log(
  `  Entity Attribution:  ${entityResult.correct}/${entityResult.correct + entityResult.wrong} korrekt`,
);
console.log(
  `  Event Attribution:   ${eventResult.correct}/${eventResult.correct + eventResult.wrong} korrekt`,
);
console.log(
  `  Relationen:          ${relationResult.correct}/${relationResult.correct + relationResult.wrong} korrekt`,
);
console.log(`  -----------------------------------------------`);
console.log(`  GESAMT-SCORE:        ${totalCorrect}/${totalChecked} = ${score}%`);
console.log(
  `  Info: ${entityResult.missing} entities fehlen, ${entityResult.extra} extra, ${eventResult.ambiguous} events nicht zuordenbar`,
);
console.log('================================================================');

// ─── SAVE HISTORY ────────────────────────────────────────────────
import fs from 'node:fs';
const historyPath = path.join('.local', 'benchmark-history.json');
const historyEntry = {
  timestamp: new Date().toISOString(),
  ingestion: `${checkpoint?.last_seq ?? 0}/${maxSeq.m}`,
  entity: {
    correct: entityResult.correct,
    wrong: entityResult.wrong,
    missing: entityResult.missing,
    extra: entityResult.extra,
  },
  events: {
    correct: eventResult.correct,
    wrong: eventResult.wrong,
    ambiguous: eventResult.ambiguous,
  },
  relations: { correct: relationResult.correct, wrong: relationResult.wrong },
  totalScore: score,
  totalCorrect,
  totalChecked,
};

let history: (typeof historyEntry)[] = [];
try {
  if (fs.existsSync(historyPath)) {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  }
} catch {
  /* fresh start */
}
history.push(historyEntry);
fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
console.log(`\n  History saved to ${historyPath} (${history.length} runs total)`);

messagesDb.close();
