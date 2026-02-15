import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';
import type { MemoryListPageInput, MemoryListPageResult, MemoryRepository } from './repository';

interface MemoryRow {
  id: string;
  persona_id: string;
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
  private readonly db: ReturnType<typeof BetterSqlite3>;

  constructor(
    dbPath = process.env.MEMORY_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db',
  ) {
    if (dbPath === ':memory:') {
      this.db = new BetterSqlite3(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new BetterSqlite3(fullPath);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
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
    if (!this.hasColumn('memory_nodes', 'persona_id')) {
      this.db.exec(
        "ALTER TABLE memory_nodes ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'persona-default';",
      );
    }
    if (!this.hasColumn('memory_nodes', 'user_id')) {
      this.db.exec(
        `ALTER TABLE memory_nodes ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_LOCAL_USER_ID}';`,
      );
    }
    this.db.exec(`
      UPDATE memory_nodes
      SET persona_id = 'persona-default'
      WHERE persona_id IS NULL OR TRIM(persona_id) = '';
    `);
    this.db.exec(`
      UPDATE memory_nodes
      SET user_id = '${LEGACY_LOCAL_USER_ID}'
      WHERE user_id IS NULL OR TRIM(user_id) = '';
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_importance
        ON memory_nodes (user_id, persona_id, importance DESC, updated_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_persona
        ON memory_nodes (user_id, persona_id, updated_at DESC);
    `);
  }

  private resolveUserId(userId?: string): string {
    const normalized = String(userId || '').trim();
    return normalized || LEGACY_LOCAL_USER_ID;
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    return rows.some((row) => row.name === columnName);
  }

  listNodes(personaId: string, userId?: string): MemoryNode[] {
    const scopedUserId = this.resolveUserId(userId);
    const rows = this.db
      .prepare(
        'SELECT * FROM memory_nodes WHERE user_id = ? AND persona_id = ? ORDER BY importance DESC, updated_at DESC',
      )
      .all(scopedUserId, personaId) as Array<Record<string, unknown>>;
    return rows.map((row) => toNode(row as unknown as MemoryRow));
  }

  listNodesPage(
    personaId: string,
    input: MemoryListPageInput,
    userId?: string,
  ): MemoryListPageResult {
    const scopedUserId = this.resolveUserId(userId);
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['user_id = ?', 'persona_id = ?'];
    const params: Array<string | number> = [scopedUserId, personaId];

    if (input.type) {
      conditions.push('type = ?');
      params.push(input.type);
    }
    if (input.query?.trim()) {
      conditions.push('(content LIKE ? OR type LIKE ?)');
      const needle = `%${input.query.trim()}%`;
      params.push(needle, needle);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countSql = `SELECT COUNT(*) as total FROM memory_nodes ${where}`;
    const totalRow = this.db.prepare(countSql).get(...params) as { total: number };
    const total = Number(totalRow?.total || 0);

    const listSql = `
      SELECT *
      FROM memory_nodes
      ${where}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(listSql).all(...params, pageSize, offset) as Array<
      Record<string, unknown>
    >;
    return {
      nodes: rows.map((row) => toNode(row as unknown as MemoryRow)),
      total,
    };
  }

  listAllNodes(userId?: string): MemoryNode[] {
    const scopedUserId = this.resolveUserId(userId);
    if (!userId) {
      const rows = this.db
        .prepare('SELECT * FROM memory_nodes ORDER BY importance DESC, updated_at DESC')
        .all() as Array<Record<string, unknown>>;
      return rows.map((row) => toNode(row as unknown as MemoryRow));
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM memory_nodes WHERE user_id = ? ORDER BY importance DESC, updated_at DESC',
      )
      .all(scopedUserId) as Array<Record<string, unknown>>;
    return rows.map((row) => toNode(row as unknown as MemoryRow));
  }

  insertNode(personaId: string, node: MemoryNode, userId?: string): void {
    const scopedUserId = this.resolveUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO memory_nodes (
          id, user_id, persona_id, type, content, embedding_json, importance, confidence, timestamp, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        node.id,
        scopedUserId,
        personaId,
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

  updateNode(personaId: string, node: MemoryNode, userId?: string): void {
    const scopedUserId = this.resolveUserId(userId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE memory_nodes
        SET type = ?, content = ?, embedding_json = ?, importance = ?, confidence = ?, timestamp = ?, metadata_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND persona_id = ?
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
        scopedUserId,
        personaId,
      );
  }

  deleteNode(personaId: string, nodeId: string, userId?: string): number {
    const scopedUserId = this.resolveUserId(userId);
    const result = this.db
      .prepare('DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ? AND id = ?')
      .run(scopedUserId, personaId, nodeId);
    return Number(result.changes || 0);
  }

  updateMany(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
    userId?: string,
  ): number {
    const scopedUserId = this.resolveUserId(userId);
    const ids = Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return 0;
    const setClauses: string[] = [];
    const setParams: Array<string | number> = [];
    if (updates.type) {
      setClauses.push('type = ?');
      setParams.push(updates.type);
    }
    if (updates.importance !== undefined) {
      setClauses.push('importance = ?');
      setParams.push(updates.importance);
    }
    if (setClauses.length === 0) return 0;
    setClauses.push('updated_at = ?');
    setParams.push(new Date().toISOString());

    const stmt = this.db.prepare(`
      UPDATE memory_nodes
      SET ${setClauses.join(', ')}
      WHERE user_id = ? AND persona_id = ? AND id = ?
    `);

    const runTx = this.db.transaction((candidateIds: string[]) => {
      let changes = 0;
      for (const id of candidateIds) {
        const result = stmt.run(...setParams, scopedUserId, personaId, id);
        changes += Number(result.changes || 0);
      }
      return changes;
    });

    return runTx(ids);
  }

  deleteMany(personaId: string, nodeIds: string[], userId?: string): number {
    const scopedUserId = this.resolveUserId(userId);
    const ids = Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      'DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ? AND id = ?',
    );
    const runTx = this.db.transaction((candidateIds: string[]) => {
      let changes = 0;
      for (const id of candidateIds) {
        const result = stmt.run(scopedUserId, personaId, id);
        changes += Number(result.changes || 0);
      }
      return changes;
    });
    return runTx(ids);
  }

  deleteByPersona(personaId: string, userId?: string): number {
    const scopedUserId = this.resolveUserId(userId);
    const result = this.db
      .prepare('DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ?')
      .run(scopedUserId, personaId);
    return Number(result.changes || 0);
  }

  getStorageSnapshot(limit = 5, personaId?: string): MemoryStorageSnapshot {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(50, Math.floor(limit)))
      : 5;
    const whereClause = personaId ? 'WHERE persona_id = ?' : '';
    const whereArgs = personaId ? [personaId] : [];

    const summaryRow = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS total_nodes,
          COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
          COALESCE(SUM(LENGTH(CAST(embedding_json AS BLOB))), 0) AS embedding_bytes,
          COALESCE(SUM(LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))), 0) AS metadata_bytes
        FROM memory_nodes
        ${whereClause}
      `,
      )
      .get(...whereArgs) as {
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
        ${whereClause}
        GROUP BY type
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          node_count DESC
      `,
      )
      .all(...whereArgs) as Array<{
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
        ${whereClause}
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          updated_at DESC
        LIMIT ?
      `,
      )
      .all(...whereArgs, normalizedLimit) as Array<{
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
