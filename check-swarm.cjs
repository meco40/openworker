const D = require('better-sqlite3');
const db = new D('.local/messages.recovered.db');

const sw = db
  .prepare(
    "SELECT id, status, current_phase, last_seq, session_id, current_deploy_command_id FROM agent_room_swarms WHERE id='swarm-7de7e11a-9a2f-4c9b-84a2-d16b181f9376'",
  )
  .get();
console.log('Swarm:', JSON.stringify(sw));

// Check events for the current deploy command
if (sw && sw.current_deploy_command_id) {
  const cmdEvents = db
    .prepare('SELECT seq, type, emitted_at FROM agent_v2_events WHERE command_id=? ORDER BY seq')
    .all(sw.current_deploy_command_id);
  console.log('Command events count:', cmdEvents.length);
  console.log('First event:', JSON.stringify(cmdEvents[0]));
  console.log('Last event:', JSON.stringify(cmdEvents[cmdEvents.length - 1]));

  // Find completed event
  const completed = cmdEvents.find((e) => e.type === 'agent.v2.command.completed');
  console.log('Completed event:', JSON.stringify(completed));
}

// Check what seq was stored when this phase was dispatched
// (i.e., what was the lastSeq saved that would let us replay from the right point)
console.log('DB lastSeq:', sw ? sw.last_seq : 'N/A');

db.close();
