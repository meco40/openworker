import BetterSqlite3 from 'better-sqlite3';

const db = new BetterSqlite3('.local/messages.db', { readonly: true });

const convId = 'db73d6b8-0edb-4484-86f9-d6a33afd28e7';

const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
console.log('=== Conversation ===');
console.log(JSON.stringify(conv, null, 2));

// Check if there are FK constraints or other references
const msgCount = db
  .prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?')
  .get(convId) as { cnt: number };
console.log(`\nMessages: ${msgCount.cnt}`);

const ctx = db.prepare('SELECT * FROM conversation_context WHERE conversation_id = ?').get(convId);
console.log('\n=== Context ===');
console.log(JSON.stringify(ctx, null, 2));

// Check all tables for references
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
  name: string;
}[];
console.log('\n=== All Tables ===');
for (const t of tables) {
  console.log(t.name);
}

// Check foreign key status
const fkStatus = db.pragma('foreign_keys');
console.log('\n=== FK Status ===');
console.log(fkStatus);

// Check all FK references to conversations table
console.log('\n=== FK References to conversations ===');
for (const t of tables) {
  const fks = db.pragma(`foreign_key_list(${t.name})`) as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  for (const fk of fks) {
    if (fk.table === 'conversations') {
      // Check if this table has entries referencing our conversation
      try {
        const count = db
          .prepare(`SELECT COUNT(*) as cnt FROM "${t.name}" WHERE "${fk.from}" = ?`)
          .get(convId) as { cnt: number };
        console.log(`  ${t.name}.${fk.from} → conversations.${fk.to}: ${count.cnt} rows`);
      } catch (e) {
        console.log(`  ${t.name}.${fk.from} → conversations.${fk.to}: (query error: ${e})`);
      }
    }
  }
}

// Also check tables by column name pattern
console.log('\n=== Tables with conversation_id column referencing our ID ===');
for (const t of tables) {
  try {
    const cols = db.pragma(`table_info(${t.name})`) as Array<{ name: string }>;
    const hasConvCol = cols.find((c) => c.name === 'conversation_id');
    if (hasConvCol) {
      const count = db
        .prepare(`SELECT COUNT(*) as cnt FROM "${t.name}" WHERE conversation_id = ?`)
        .get(convId) as { cnt: number };
      if (count.cnt > 0) {
        console.log(`  ${t.name}: ${count.cnt} rows`);
      }
    }
  } catch (_e) {
    /* skip */
  }
}

db.close();
