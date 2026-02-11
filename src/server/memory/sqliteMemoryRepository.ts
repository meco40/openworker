import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryNode } from '../../../core/memory/types';
import type { MemoryRepository } from './repository';

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  embedding_json: string;
  importance: number;
  confidence: number;
  timestamp: string;
  metadata_json: string | null;
}

function toNode(row: MemoryRow): MemoryNode {
  return {
    id: row.id,
    type: row.type as MemoryNode['type'],
    content: row.content,
    embedding: JSON.parse(row.embedding_json) as number[],
    importance: row.importance,
    confidence: row.confidence,
    timestamp: row.timestamp,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as NonNullable<MemoryNode['metadata']>)
      : undefined,
  };
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(
    dbPath =
      process.env.MEMORY_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence REAL NOT NULL,
        timestamp TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_importance
        ON memory_nodes (importance DESC, updated_at DESC);
    `);
  }

  listNodes(): MemoryNode[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_nodes ORDER BY importance DESC, updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => toNode(row as unknown as MemoryRow));
  }

  insertNode(node: MemoryNode): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO memory_nodes (
          id, type, content, embedding_json, importance, confidence, timestamp, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        node.id,
        node.type,
        node.content,
        JSON.stringify(node.embedding),
        node.importance,
        node.confidence,
        node.timestamp,
        node.metadata ? JSON.stringify(node.metadata) : null,
        now,
        now,
      );
  }

  updateNode(node: MemoryNode): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE memory_nodes
        SET type = ?, content = ?, embedding_json = ?, importance = ?, confidence = ?, timestamp = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        node.type,
        node.content,
        JSON.stringify(node.embedding),
        node.importance,
        node.confidence,
        node.timestamp,
        node.metadata ? JSON.stringify(node.metadata) : null,
        now,
        node.id,
      );
  }
}
