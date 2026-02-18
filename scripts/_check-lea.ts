import SqliteDatabase from 'better-sqlite3';

// Check persona
const pdb = new SqliteDatabase('.local/personas.db', { readonly: true });
const persona = pdb
  .prepare(
    `SELECT id, name, memory_persona_type FROM personas WHERE id = '48979798-6783-4ae2-895b-1d0222b2af26'`,
  )
  .get() as Record<string, unknown> | undefined;
console.log('\n=== PERSONA LEA ===');
console.log(JSON.stringify(persona, null, 2));
pdb.close();

// Check messages DB for Lea's conversations
const mdb = new SqliteDatabase('.local/messages.db', { readonly: true });

const convCount = mdb
  .prepare(
    `SELECT COUNT(*) as cnt FROM conversations WHERE persona_id = '48979798-6783-4ae2-895b-1d0222b2af26'`,
  )
  .get() as { cnt: number };
console.log('\n=== CONVERSATIONS ===');
console.log(`Total conversations: ${convCount.cnt}`);

const msgCount = mdb
  .prepare(
    `SELECT COUNT(*) as cnt FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE persona_id = '48979798-6783-4ae2-895b-1d0222b2af26')`,
  )
  .get() as { cnt: number };
console.log(`Total messages: ${msgCount.cnt}`);

// Check knowledge tables
const tables = [
  'knowledge_episodes',
  'knowledge_entities',
  'knowledge_events',
  'knowledge_aliases',
  'knowledge_meeting_ledger',
];
console.log('\n=== KNOWLEDGE TABLES (Lea) ===');
for (const table of tables) {
  try {
    const count = mdb
      .prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE persona_id = '48979798-6783-4ae2-895b-1d0222b2af26'`,
      )
      .get() as { cnt: number };
    console.log(`${table}: ${count.cnt} rows`);
  } catch {
    console.log(`${table}: table not found or error`);
  }
}

// Check ingestion cursor
console.log('\n=== INGESTION CURSOR ===');
try {
  const cursor = mdb
    .prepare(
      `SELECT * FROM knowledge_ingestion_cursor WHERE persona_id = '48979798-6783-4ae2-895b-1d0222b2af26'`,
    )
    .all();
  console.log(`Cursor entries: ${cursor.length}`);
  for (const c of cursor) {
    console.log(JSON.stringify(c));
  }
} catch {
  console.log('No cursor table or no entries');
}

mdb.close();
