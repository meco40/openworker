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
      const fullPath = path.resolve(dbPath);
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

  getStorageSnapshot(limit = 5): MemoryStorageSnapshot {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(50, Math.floor(limit)))
      : 5;

    const summaryRow = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_nodes,
          COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
          COALESCE(SUM(LENGTH(CAST(embedding_json AS BLOB))), 0) AS embedding_bytes,
          COALESCE(SUM(LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))), 0) AS metadata_bytes
        FROM memory_nodes
      `,
      )
      .get() as {
      total_nodes: number;
      content_bytes: number;
      embedding_bytes: number;
      metadata_bytes: number;
    };

    const byTypeRows = this.db
      .prepare(
        `
        SELECT
          type,
          COUNT(*) AS node_count,
          COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
          COALESCE(SUM(LENGTH(CAST(embedding_json AS BLOB))), 0) AS embedding_bytes,
          COALESCE(SUM(LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))), 0) AS metadata_bytes
        FROM memory_nodes
        GROUP BY type
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          node_count DESC
      `,
      )
      .all() as Array<{
      type: string;
      node_count: number;
      content_bytes: number;
      embedding_bytes: number;
      metadata_bytes: number;
    }>;

    const largestRows = this.db
      .prepare(
        `
        SELECT
          id,
          type,
          LENGTH(CAST(content AS BLOB)) AS content_bytes,
          LENGTH(CAST(embedding_json AS BLOB)) AS embedding_bytes,
          LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB)) AS metadata_bytes
        FROM memory_nodes
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          updated_at DESC
        LIMIT ?
      `,
      )
      .all(normalizedLimit) as Array<{
      id: string;
      type: string;
      content_bytes: number;
      embedding_bytes: number;
      metadata_bytes: number;
    }>;

    const summary: MemoryStorageSummary = {
      totalNodes: Number(summaryRow.total_nodes || 0),
      contentBytes: Number(summaryRow.content_bytes || 0),
      embeddingBytes: Number(summaryRow.embedding_bytes || 0),
      metadataBytes: Number(summaryRow.metadata_bytes || 0),
      totalBytes:
        Number(summaryRow.content_bytes || 0) +
        Number(summaryRow.embedding_bytes || 0) +
        Number(summaryRow.metadata_bytes || 0),
    };

    const byType: MemoryStorageByType[] = byTypeRows.map((row) => {
      const contentBytes = Number(row.content_bytes || 0);
      const embeddingBytes = Number(row.embedding_bytes || 0);
      const metadataBytes = Number(row.metadata_bytes || 0);
      return {
        type: row.type,
        count: Number(row.node_count || 0),
        contentBytes,
        embeddingBytes,
        metadataBytes,
        totalBytes: contentBytes + embeddingBytes + metadataBytes,
      };
    });

    const largestNodes: MemoryStorageNodeSize[] = largestRows.map((row) => {
      const contentBytes = Number(row.content_bytes || 0);
      const embeddingBytes = Number(row.embedding_bytes || 0);
      const metadataBytes = Number(row.metadata_bytes || 0);
      return {
        id: row.id,
        type: row.type,
        contentBytes,
        embeddingBytes,
        metadataBytes,
        totalBytes: contentBytes + embeddingBytes + metadataBytes,
      };
    });

    return { summary, byType, largestNodes };
  }
}

export interface MemoryStorageSummary {
  totalNodes: number;
  totalBytes: number;
  contentBytes: number;
  embeddingBytes: number;
  metadataBytes: number;
}

export interface MemoryStorageByType {
  type: string;
  count: number;
  totalBytes: number;
  contentBytes: number;
  embeddingBytes: number;
  metadataBytes: number;
}

export interface MemoryStorageNodeSize {
  id: string;
  type: string;
  totalBytes: number;
  contentBytes: number;
  embeddingBytes: number;
  metadataBytes: number;
}

export interface MemoryStorageSnapshot {
  summary: MemoryStorageSummary;
  byType: MemoryStorageByType[];
  largestNodes: MemoryStorageNodeSize[];
}

