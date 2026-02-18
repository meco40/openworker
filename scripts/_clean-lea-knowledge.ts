import SqliteDatabase from 'better-sqlite3';

const LEA_ID = '48979798-6783-4ae2-895b-1d0222b2af26';
const db = new SqliteDatabase('.local/messages.db');

// List all knowledge tables
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge%'")
  .all() as Array<{ name: string }>;
console.log(
  'Knowledge tables:',
  tables.map((t) => t.name),
);

// Count rows per table for Lea
for (const { name } of tables) {
  try {
    const count = db
      .prepare(`SELECT COUNT(*) as cnt FROM "${name}" WHERE persona_id = ?`)
      .get(LEA_ID) as { cnt: number };
    console.log(`  ${name}: ${count.cnt} rows`);
  } catch {
    console.log(`  ${name}: no persona_id column`);
  }
}

// Clean all knowledge data for Lea
console.log('\n--- Cleaning Lea knowledge data ---');
for (const { name } of tables) {
  try {
    const result = db.prepare(`DELETE FROM "${name}" WHERE persona_id = ?`).run(LEA_ID);
    console.log(`  Deleted ${result.changes} rows from ${name}`);
  } catch {
    console.log(`  Skipped ${name} (no persona_id column)`);
  }
}

// Also clean cursor if it exists
try {
  const cursorTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%cursor%'")
    .all() as Array<{ name: string }>;
  for (const { name } of cursorTables) {
    try {
      const result = db.prepare(`DELETE FROM "${name}" WHERE persona_id = ?`).run(LEA_ID);
      console.log(`  Deleted ${result.changes} rows from ${name} (cursor)`);
    } catch {
      // no persona_id column
    }
  }
} catch {
  /* no cursor tables */
}

// Also clean conversation_summaries
try {
  const result = db.prepare(`DELETE FROM conversation_summaries WHERE persona_id = ?`).run(LEA_ID);
  console.log(`  Deleted ${result.changes} rows from conversation_summaries`);
} catch {
  console.log('  No conversation_summaries table or no persona_id column');
}

// Verify clean state
console.log('\n--- Verification (should all be 0) ---');
for (const { name } of tables) {
  try {
    const count = db
      .prepare(`SELECT COUNT(*) as cnt FROM "${name}" WHERE persona_id = ?`)
      .get(LEA_ID) as { cnt: number };
    console.log(`  ${name}: ${count.cnt} rows`);
  } catch {
    // skip
  }
}

db.close();
console.log('\nDone — Lea knowledge data cleaned.');
