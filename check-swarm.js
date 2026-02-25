import Database from 'better-sqlite3';

const db = new Database('.local/messages.recovered.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map((t) => t.name).join(', '));

const sw = db
  .prepare(
    "SELECT id, status, current_phase, last_seq, session_id FROM agent_room_swarms WHERE id='swarm-7de7e11a-9a2f-4c9b-84a2-d16b181f9376'",
  )
  .get();
console.log('Swarm:', JSON.stringify(sw));

// Look for events in session_events table
try {
  const evtCols = db.prepare('PRAGMA table_info(session_events)').all();
  console.log('session_events cols:', evtCols.map((c) => c.name).join(', '));
  if (sw) {
    const cnt = db
      .prepare('SELECT COUNT(*), MAX(seq) as maxseq FROM session_events WHERE session_id=?')
      .get(sw.session_id);
    console.log('Event count / max seq:', JSON.stringify(cnt));
    const last = db
      .prepare(
        'SELECT seq, event_type, created_at FROM session_events WHERE session_id=? ORDER BY seq DESC LIMIT 5',
      )
      .all(sw.session_id);
    console.log('Last 5 events:', JSON.stringify(last));
  }
} catch (e) {
  console.log('No session_events table:', e.message);
}

db.close();
