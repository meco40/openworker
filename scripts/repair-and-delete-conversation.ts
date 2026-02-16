import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';

const DB_PATH = '.local/messages.db';
const BACKUP_PATH = '.local/messages.db.backup-pre-repair';
const CONV_ID = 'db73d6b8-0edb-4484-86f9-d6a33afd28e7';

// Step 1: Backup
console.log('=== Step 1: Backup ===');
if (!existsSync(BACKUP_PATH)) {
  copyFileSync(DB_PATH, BACKUP_PATH);
  console.log(`Backed up to ${BACKUP_PATH}`);
} else {
  console.log('Backup already exists, skipping');
}

// Step 2: Check integrity
console.log('\n=== Step 2: Integrity Check ===');
const db = new BetterSqlite3(DB_PATH);

try {
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  console.log('Main DB integrity:', integrity[0]?.integrity_check);
} catch (e) {
  console.log('Integrity check error:', e);
}

// Step 3: Try to rebuild FTS5 index (this often fixes corruption)
console.log('\n=== Step 3: Rebuild FTS5 Index ===');
try {
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  console.log('FTS5 rebuild succeeded');
} catch (e) {
  console.log('FTS5 rebuild failed:', e);
  
  // Step 3b: Drop and recreate FTS table
  console.log('\n=== Step 3b: Drop and Recreate FTS ===');
  try {
    // Drop triggers first
    db.exec('DROP TRIGGER IF EXISTS messages_ai');
    db.exec('DROP TRIGGER IF EXISTS messages_ad');
    db.exec('DROP TRIGGER IF EXISTS messages_au');
    console.log('Dropped triggers');
    
    // Drop FTS table
    db.exec('DROP TABLE IF EXISTS messages_fts');
    console.log('Dropped messages_fts');
    
    // Recreate FTS table
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    console.log('Recreated messages_fts');
    
    // Recreate triggers
    db.exec(`
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;
    `);
    db.exec(`
      CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;
    `);
    console.log('Recreated triggers');
    
    // Rebuild from existing data
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    console.log('FTS5 rebuild from existing data succeeded');
  } catch (e2) {
    console.log('Drop/recreate also failed:', e2);
  }
}

// Step 4: Check integrity again
console.log('\n=== Step 4: Post-repair Integrity Check ===');
try {
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  console.log('Main DB integrity:', integrity[0]?.integrity_check);
} catch (e) {
  console.log('Post-repair integrity check error:', e);
}

// Step 5: Test delete operation
console.log('\n=== Step 5: Test Delete ===');
try {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(CONV_ID) as Record<string, unknown> | undefined;
  if (!conv) {
    console.log('Conversation not found (already deleted?)');
  } else {
    console.log(`Found conversation: ${conv.title} (${conv.channel_type})`);
    
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?').get(CONV_ID) as { cnt: number };
    console.log(`Messages to delete: ${msgCount.cnt}`);
    
    // Try the actual delete sequence
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(CONV_ID);
    console.log('Messages deleted');
    
    db.prepare('DELETE FROM conversation_context WHERE conversation_id = ?').run(CONV_ID);
    console.log('Context deleted');
    
    // Also clean up knowledge tables
    db.prepare('DELETE FROM knowledge_ingestion_checkpoints WHERE conversation_id = ?').run(CONV_ID);
    db.prepare('DELETE FROM knowledge_episodes WHERE conversation_id = ?').run(CONV_ID);
    db.prepare('DELETE FROM knowledge_meeting_ledger WHERE conversation_id = ?').run(CONV_ID);
    db.prepare('DELETE FROM knowledge_retrieval_audit WHERE conversation_id = ?').run(CONV_ID);
    console.log('Knowledge tables cleaned');
    
    const result = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(CONV_ID, 'legacy-local-user');
    console.log(`Conversation deleted: ${result.changes} row(s) affected`);
  }
} catch (e) {
  console.log('Delete failed:', e);
}

// Final check
const remaining = db.prepare('SELECT COUNT(*) as cnt FROM conversations').get() as { cnt: number };
console.log(`\nRemaining conversations: ${remaining.cnt}`);

db.close();
console.log('\nDone!');
