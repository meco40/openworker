/**
 * Restore messages from backup DB into current DB.
 *
 * Strategy:
 * - Read all 362 messages from old conversation in backup
 * - Insert them into the CURRENT DB under the new Telegram conversation
 * - Shift existing new messages' seq numbers up to make room
 * - FTS5 triggers will auto-index the restored messages
 */
import BetterSqlite3 from 'better-sqlite3';

const BACKUP_PATH = '.local/messages.db.backup-pre-repair';
const CURRENT_PATH = '.local/messages.db';
const OLD_CONV_ID = 'db73d6b8-0edb-4484-86f9-d6a33afd28e7';
const NEW_CONV_ID = '78f081b5-032c-49aa-883b-8956f78112e0';

// 1. Open both DBs
const backupDb = new BetterSqlite3(BACKUP_PATH, { readonly: true });
const currentDb = new BetterSqlite3(CURRENT_PATH);

// 2. Read old messages from backup (ordered by seq)
const oldMessages = backupDb
  .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
  .all(OLD_CONV_ID) as Array<Record<string, unknown>>;

console.log(`Backup messages to restore: ${oldMessages.length}`);

if (oldMessages.length === 0) {
  console.log('No messages found in backup!');
  process.exit(1);
}

// 3. Read current messages in new conversation
const currentMessages = currentDb
  .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
  .all(NEW_CONV_ID) as Array<Record<string, unknown>>;

console.log(`Current messages in new conv: ${currentMessages.length}`);

const maxOldSeq = oldMessages[oldMessages.length - 1].seq as number;
console.log(`Max seq in old messages: ${maxOldSeq}`);

// 4. Shift existing new messages' seq numbers up to make room
const seqOffset = maxOldSeq;
if (currentMessages.length > 0) {
  // Update in reverse order to avoid unique constraint violations
  const updateSeq = currentDb.prepare('UPDATE messages SET seq = seq + ? WHERE id = ?');

  const shiftTransaction = currentDb.transaction(() => {
    // Process in reverse seq order to prevent conflicts
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const msg = currentMessages[i];
      updateSeq.run(seqOffset, msg.id);
    }
  });
  shiftTransaction();
  console.log(`Shifted ${currentMessages.length} existing messages by +${seqOffset}`);
}

// 5. Insert old messages with new conversation_id
const insertMsg = currentDb.prepare(`
  INSERT INTO messages (id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertTransaction = currentDb.transaction(() => {
  let inserted = 0;
  for (const msg of oldMessages) {
    try {
      insertMsg.run(
        msg.id,
        NEW_CONV_ID, // New conversation ID
        msg.seq,
        msg.role,
        msg.content,
        msg.platform,
        msg.external_msg_id ?? null,
        msg.sender_name ?? null,
        msg.metadata ?? null,
        msg.created_at,
      );
      inserted++;
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes('UNIQUE constraint')) {
        console.log(`  Skipping duplicate: ${(msg.id as string).substring(0, 20)}...`);
      } else {
        throw e;
      }
    }
  }
  return inserted;
});

const inserted = insertTransaction();
console.log(`Inserted ${inserted} messages from backup`);

// 6. Also restore conversation_context (summary) from backup
const oldContext = backupDb
  .prepare('SELECT * FROM conversation_context WHERE conversation_id = ?')
  .get(OLD_CONV_ID) as Record<string, unknown> | undefined;

if (oldContext) {
  // Update existing context or insert new one
  const existingContext = currentDb
    .prepare('SELECT * FROM conversation_context WHERE conversation_id = ?')
    .get(NEW_CONV_ID);

  if (existingContext) {
    currentDb
      .prepare(
        'UPDATE conversation_context SET summary_text = ?, summary_upto_seq = ?, updated_at = ? WHERE conversation_id = ?',
      )
      .run(
        oldContext.summary_text,
        oldContext.summary_upto_seq,
        new Date().toISOString(),
        NEW_CONV_ID,
      );
    console.log('Updated conversation context/summary from backup');
  } else {
    currentDb
      .prepare(
        'INSERT INTO conversation_context (conversation_id, summary_text, summary_upto_seq, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        NEW_CONV_ID,
        oldContext.summary_text,
        oldContext.summary_upto_seq,
        new Date().toISOString(),
      );
    console.log('Inserted conversation context/summary from backup');
  }
}

// 7. Restore knowledge tables from backup
const knowledgeTables = [
  'knowledge_episodes',
  'knowledge_meeting_ledger',
  'knowledge_retrieval_audit',
  'knowledge_ingestion_checkpoints',
];

for (const name of knowledgeTables) {
  try {
    const rows = backupDb
      .prepare(`SELECT * FROM ${name} WHERE conversation_id = ?`)
      .all(OLD_CONV_ID) as Array<Record<string, unknown>>;

    if (rows.length === 0) continue;

    // Get column names from first row
    const cols = Object.keys(rows[0]);

    const placeholders = cols.map(() => '?').join(', ');
    const insert = currentDb.prepare(
      `INSERT OR REPLACE INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`,
    );

    let restored = 0;
    const tx = currentDb.transaction(() => {
      for (const row of rows) {
        const values = cols.map((c) => {
          if (c === 'conversation_id') return NEW_CONV_ID;
          return row[c] ?? null;
        });
        insert.run(...values);
        restored++;
      }
    });
    tx();
    console.log(`Restored ${restored} rows in ${name}`);
  } catch (e) {
    console.log(`Skipped ${name}: ${e}`);
  }
}

// 8. Verify
const totalMessages = currentDb
  .prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?')
  .get(NEW_CONV_ID) as { cnt: number };

console.log(`\n=== Verification ===`);
console.log(`Total messages in new conversation: ${totalMessages.cnt}`);

// Verify FTS5 has the restored messages
const ftsCheck = currentDb
  .prepare(
    `
  SELECT COUNT(*) as cnt
  FROM messages m
  JOIN messages_fts fts ON fts.rowid = m.rowid
  WHERE m.conversation_id = ? AND messages_fts MATCH 'Regeln'
`,
  )
  .get(NEW_CONV_ID) as { cnt: number };

console.log(`FTS5 matches for "Regeln" in new conv: ${ftsCheck.cnt}`);

// Find the specific "Merken sie sich" message
const merkenMsg = currentDb
  .prepare(
    `
  SELECT id, seq, role, substr(content, 1, 150) as preview
  FROM messages
  WHERE conversation_id = ? AND content LIKE '%Merken%sie%sich%'
  LIMIT 3
`,
  )
  .all(NEW_CONV_ID) as Array<{ id: string; seq: number; role: string; preview: string }>;

console.log(`\n"Merken sie sich" messages found: ${merkenMsg.length}`);
for (const m of merkenMsg) {
  console.log(`  [seq:${m.seq}] [${m.role}] ${m.preview}`);
}

backupDb.close();
currentDb.close();
console.log('\nDone! Messages restored.');
