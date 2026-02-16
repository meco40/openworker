/**
 * Cleanup script: Remove duplicate "Wie sind die Regeln?" test messages
 * from the Nata Girl conversation, keeping only the original user instruction
 * that contains the 5-point ruleset.
 *
 * Usage: npx tsx scripts/cleanup-test-messages.ts
 */
import BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = path.join(process.cwd(), '.local', 'messages.db');
const CONVERSATION_ID = 'db73d6b8-0edb-4484-86f9-d6a33afd28e7';

// The original user instruction with the 5-point rules — KEEP this
const KEEP_PATTERN = 'Merken sie sich: D,ie Regeln sind';

const db = new BetterSqlite3(DB_PATH);

// 1. Find all messages in this conversation that are test duplicates
const allMessages = db.prepare(`
  SELECT id, seq, role, substr(content, 1, 120) as preview, length(content) as len
  FROM messages
  WHERE conversation_id = ?
  ORDER BY seq
`).all(CONVERSATION_ID) as Array<{
  id: string; seq: number; role: string; preview: string; len: number;
}>;

console.log(`Total messages in conversation: ${allMessages.length}`);

// 2. Identify messages to delete:
//    - User messages that are exactly "Wie sind die Regeln?" (our test queries)
//    - Agent responses that are paraphrased rule answers from those test queries
//    BUT keep the original "Merken sie sich: D,ie Regeln sind..." user message
//    AND keep the agent response immediately after it

// Find the seq of the original rules message
const originalRulesMsg = db.prepare(`
  SELECT seq FROM messages
  WHERE conversation_id = ? AND content LIKE ?
  ORDER BY seq LIMIT 1
`).get(CONVERSATION_ID, `%${KEEP_PATTERN}%`) as { seq: number } | undefined;

if (!originalRulesMsg) {
  console.error('Could not find the original rules message!');
  process.exit(1);
}
console.log(`Original rules message at seq: ${originalRulesMsg.seq}`);

// Find test user queries (exact "Wie sind die Regeln?" messages)
const testQueries = db.prepare(`
  SELECT id, seq, substr(content, 1, 80) as preview
  FROM messages
  WHERE conversation_id = ?
    AND role = 'user'
    AND (content = 'Wie sind die Regeln?' OR content = 'Wie sind die Regeln')
  ORDER BY seq
`).all(CONVERSATION_ID) as Array<{ id: string; seq: number; preview: string }>;

console.log(`\nTest query messages ("Wie sind die Regeln?"): ${testQueries.length}`);
testQueries.forEach(m => console.log(`  seq=${m.seq} id=${m.id} "${m.preview}"`));

// Collect IDs to delete: each test query + the agent response immediately after it
const idsToDelete: string[] = [];
const seqsToDelete = new Set<number>();

for (const q of testQueries) {
  idsToDelete.push(q.id);
  seqsToDelete.add(q.seq);

  // Find the agent response right after this query
  const response = db.prepare(`
    SELECT id, seq FROM messages
    WHERE conversation_id = ? AND seq = ? AND role = 'agent'
  `).get(CONVERSATION_ID, q.seq + 1) as { id: string; seq: number } | undefined;

  if (response) {
    idsToDelete.push(response.id);
    seqsToDelete.add(response.seq);
  }
}

console.log(`\nTotal messages to delete: ${idsToDelete.length}`);
console.log(`Sequences: ${[...seqsToDelete].sort((a, b) => a - b).join(', ')}`);

if (idsToDelete.length === 0) {
  console.log('Nothing to delete.');
  process.exit(0);
}

// 3. Delete from messages table (triggers auto-clean FTS index)
const deleteMsg = db.prepare(`DELETE FROM messages WHERE id = ?`);

const deleteAll = db.transaction(() => {
  let msgDeleted = 0;
  for (const id of idsToDelete) {
    const msgResult = deleteMsg.run(id);
    msgDeleted += msgResult.changes;
  }
  return { msgDeleted };
});

const result = deleteAll();
console.log(`\nDeleted: ${result.msgDeleted} messages (FTS cleaned via triggers)`);

// 4. Verify
const remaining = db.prepare(`
  SELECT count(*) as cnt FROM messages
  WHERE conversation_id = ?
`).get(CONVERSATION_ID) as { cnt: number };

console.log(`Remaining messages in conversation: ${remaining.cnt}`);

db.close();
console.log('Done.');
