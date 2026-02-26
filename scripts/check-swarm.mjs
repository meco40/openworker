import Database from 'better-sqlite3';

const dbPath = '.local/messages.recovered.db';

console.log('Using DB:', dbPath);
const db = new Database(dbPath);

// List tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:', tables.map((t) => t.name).join(', '));

// Find the swarm table
const swarmTable = tables.find((t) => t.name.includes('swarm'));
if (!swarmTable) {
  console.log('No swarm table found');
  db.close();
  process.exit(1);
}

console.log('Using table:', swarmTable.name);
const cols = db.prepare(`PRAGMA table_info(${swarmTable.name})`).all();
console.log('Columns:', cols.map((c) => c.name).join(', '));

// List all swarms
const all = db
  .prepare(
    `SELECT id, status, current_phase, hold_flag, updated_at FROM ${swarmTable.name} ORDER BY updated_at DESC LIMIT 10`,
  )
  .all();
console.log('\n=== All swarms ===');
all.forEach((r) =>
  console.log(
    `  ${r.id} | ${r.status} | phase=${r.current_phase} | hold=${r.hold_flag} | ${r.updated_at}`,
  ),
);

// Get latest swarm details
const row = all[0];
if (row) {
  const full = db.prepare(`SELECT * FROM ${swarmTable.name} WHERE id = ?`).get(row.id);
  console.log('\n=== Latest Swarm Detail ===');
  console.log('id:', full.id);
  console.log('status:', full.status);
  console.log('current_phase:', full.current_phase);
  console.log('hold_flag:', full.hold_flag);
  console.log('current_deploy_command_id:', full.current_deploy_command_id);
  console.log('session_id:', full.session_id);
  console.log('last_seq:', full.last_seq);
  console.log('artifact_json length:', (full.artifact_json || '').length);
  console.log('artifact_json (FULL):', full.artifact_json || '(empty)');

  // Test turn counting with same regex as code
  const artifact = full.artifact_json || '';
  const totalTurnRegex = /^\s*\*\*\[[^\]\n*]+?\]:\*\*/gm;
  const totalMatches = artifact.match(totalTurnRegex);
  console.log('\n=== Turn Counting ===');
  console.log('Total turns (countStructuredTurns):', totalMatches ? totalMatches.length : 0);
  if (totalMatches)
    totalMatches.forEach((m, i) =>
      console.log(`  turn ${i}: ${JSON.stringify(m.trim().slice(0, 40))}`),
    );

  // Count turns in current phase (after last marker)
  const phaseMarkerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let mm;
  while ((mm = phaseMarkerRegex.exec(artifact))) {
    console.log(`  Phase marker at ${mm.index}: ${JSON.stringify(mm[0])}`);
    lastMarkerEnd = mm.index + mm[0].length;
  }
  const textAfterMarker = artifact.slice(lastMarkerEnd);
  const turnsInPhase = textAfterMarker.match(totalTurnRegex);
  console.log('Turns in current phase:', turnsInPhase ? turnsInPhase.length : 0);
  console.log('Required for ideation (2 agents):', 2 * 2); // 2 rounds * 2 agents
  console.log('phase_buffer_json:', full.phase_buffer_json);
  console.log('units_json:', full.units_json);
  console.log('friction_json:', full.friction_json);
}

// Check agent v2 events for the swarm's sessions
const sessions = [
  'agent-session-e71c47cc-520d-470b-ba24-50c2666fdc78', // Next.js Dev
  'agent-session-cf78c7b4-c8f8-4cba-9f9f-a0037f71dbbf', // Code Reviewer
];

// check columns first
const evtCols = db.prepare(`PRAGMA table_info(agent_v2_events)`).all();
console.log('\n=== agent_v2_events columns ===');
console.log(evtCols.map((c) => c.name).join(', '));

const cmdCols = db.prepare(`PRAGMA table_info(agent_v2_commands)`).all();
console.log('\n=== agent_v2_commands columns ===');
console.log(cmdCols.map((c) => c.name).join(', '));

for (const sid of sessions) {
  const evts = db
    .prepare(
      `SELECT seq, type, command_id FROM agent_v2_events WHERE session_id = ? AND type NOT LIKE '%delta%' ORDER BY seq`,
    )
    .all(sid);
  console.log(`\n=== Non-delta Events for session ...${sid.slice(-12)} (${evts.length}) ===`);
  evts.forEach((e) =>
    console.log(`  seq=${e.seq} type=${e.type} cmd=${(e.command_id || '').slice(-12)}`),
  );
}

// Check commands
const cmds = db
  .prepare(
    `SELECT id, session_id, status, skill_name FROM agent_v2_commands WHERE session_id IN (?, ?) ORDER BY seq`,
  )
  .all(...sessions);
console.log(`\n=== Commands (${cmds.length}) ===`);
cmds.forEach((c) =>
  console.log(
    `  ${c.id.slice(-12)} session=...${c.session_id.slice(-12)} status=${c.status} skill=${c.skill_name}`,
  ),
);

db.close();
