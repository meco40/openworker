import SqliteDatabase from 'better-sqlite3';

const db = new SqliteDatabase('.local/messages.db', { readonly: true });

console.log('=== CHECKPOINTS ===');
const checkpoints = db.prepare('SELECT * FROM knowledge_ingestion_checkpoints').all();
console.log(JSON.stringify(checkpoints, null, 2));

console.log('\n=== TABLE SCHEMA ===');
const info = db.prepare("PRAGMA table_info('knowledge_ingestion_checkpoints')").all();
console.log(JSON.stringify(info, null, 2));

db.close();
