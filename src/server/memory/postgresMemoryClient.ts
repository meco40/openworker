import { randomUUID } from 'node:crypto';

import type {
  MemoryProviderKind,
  Mem0Client,
  Mem0HistoryEntry,
  Mem0ListInput,
  Mem0ListMemoryResult,
  Mem0MemoryInput,
  Mem0MemoryRecord,
  Mem0Scope,
  Mem0SearchHit,
  Mem0SearchInput,
} from '@/server/memory/mem0';
import {
  getWorldModelDb,
  runWithWorldModelScope,
  withWorldModelTransaction,
} from '@/server/world-model/db';
import { getConfiguredEmbeddingProvider } from '@/server/world-model/embeddings/provider';
import { vectorSearch } from '@/server/world-model/retrieval/vector';
import { MemoryVersionConflictError } from './errors';

type DbTimestamp = string | Date | null | undefined;

interface CanonicalMemoryRow {
  id: string;
  user_id: string;
  persona_id: string;
  workspace_id: string;
  memory_type: string;
  content: string;
  importance: number;
  confidence: number;
  lifecycle_status: string;
  version: number;
  metadata: Record<string, unknown>;
  idempotency_key: string | null;
  legacy_provider: string | null;
  legacy_provider_id: string | null;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

interface CanonicalHistoryRow {
  action: string;
  version: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: DbTimestamp;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function timestamp(value: DbTimestamp): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scopeFrom(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
}): Required<Mem0Scope> {
  return {
    userId: text(input.userId),
    personaId: text(input.personaId),
    workspaceId: text(input.workspaceId),
  };
}

function scopeFromMemoryInput(input: Mem0MemoryInput, scope?: Mem0Scope): Required<Mem0Scope> {
  const inputMetadata = metadata(input.metadata);
  return scopeFrom({
    userId: input.userId,
    personaId: input.personaId,
    workspaceId: scope?.workspaceId ?? text(input.workspaceId ?? inputMetadata.workspaceId),
  });
}

function rowMetadata(row: CanonicalMemoryRow): Record<string, unknown> {
  return {
    ...metadata(row.metadata),
    type: row.memory_type,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    lifecycleStatus: row.lifecycle_status,
    version: Number(row.version),
    source: text(metadata(row.metadata).source) || 'postgres',
    memoryProvider: 'postgres' satisfies MemoryProviderKind,
    memoryId: row.id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.legacy_provider_id ? { legacyProviderId: row.legacy_provider_id } : {}),
    lastVerified: timestamp(row.updated_at),
  };
}

function toRecord(row: CanonicalMemoryRow, score: number | null = null): Mem0MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    score,
    metadata: rowMetadata(row),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function historyEntry(row: CanonicalHistoryRow): Mem0HistoryEntry {
  return {
    action: row.action,
    timestamp: timestamp(row.created_at),
    content: row.content,
    metadata: {
      ...metadata(row.metadata),
      version: Number(row.version),
    },
    raw: {
      action: row.action,
      version: Number(row.version),
      content: row.content,
      metadata: metadata(row.metadata),
    },
  };
}

function safePage(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

function safePageSize(value: number): number {
  return Math.max(1, Math.min(200, Math.floor(Number.isFinite(value) ? value : 50)));
}

/**
 * PostgreSQL-backed implementation of the legacy Mem0-shaped contract.
 *
 * The contract name is retained so existing API/knowledge callers remain
 * stable. No Mem0 request is made here: rows, history and embeddings all live
 * in the canonical World Model database.
 */
export class PostgresMemoryClient implements Mem0Client {
  readonly provider = 'postgres' as const;

  async addMemory(input: Mem0MemoryInput): Promise<{ id: string; created: boolean }> {
    const scope = scopeFromMemoryInput(input);
    const inputMetadata = metadata(input.metadata);
    const idempotencyKey = text(inputMetadata.idempotencyKey) || null;
    const legacyProvider = text(inputMetadata.legacyProvider) || null;
    const legacyProviderId =
      text(inputMetadata.legacyMem0Id || inputMetadata.legacyProviderId) || null;
    const id = randomUUID();
    const memoryType = text(inputMetadata.type) || 'fact';
    const importance = Math.min(5, Math.max(1, Math.round(Number(inputMetadata.importance) || 3)));
    const confidence = Math.min(1, Math.max(0.1, Number(inputMetadata.confidence) || 0.3));
    const lifecycleStatus = text(inputMetadata.lifecycleStatus) || 'new';
    const version = Math.max(1, Math.floor(Number(inputMetadata.version) || 1));
    const sourceObservationId =
      text(inputMetadata.sourceObservationId || inputMetadata.source_observation_id) || null;

    const canonical = await withWorldModelTransaction(async (db) => {
      if (idempotencyKey) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM world_model_memory_items
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND idempotency_key = $4 AND deleted_at IS NULL
           LIMIT 1`,
          [scope.userId, scope.personaId, scope.workspaceId, idempotencyKey],
        );
        if (existing.rows[0]?.id) return { id: existing.rows[0].id, created: false };
      }
      if (legacyProvider && legacyProviderId) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM world_model_memory_items
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND legacy_provider = $4 AND legacy_provider_id = $5
           LIMIT 1`,
          [scope.userId, scope.personaId, scope.workspaceId, legacyProvider, legacyProviderId],
        );
        if (existing.rows[0]?.id) return { id: existing.rows[0].id, created: false };
      }

      const inserted = await db.query<{ id: string }>(
        `INSERT INTO world_model_memory_items
          (id, user_id, persona_id, workspace_id, memory_type, content,
           importance, confidence, lifecycle_status, version, metadata,
           idempotency_key, legacy_provider, legacy_provider_id, source_observation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          id,
          scope.userId,
          scope.personaId,
          scope.workspaceId,
          memoryType,
          input.content,
          importance,
          confidence,
          lifecycleStatus,
          version,
          JSON.stringify(inputMetadata),
          idempotencyKey,
          legacyProvider,
          legacyProviderId,
          sourceObservationId,
        ],
      );
      if (!inserted.rows[0]?.id) {
        const conflict = await db.query<{ id: string }>(
          `SELECT id FROM world_model_memory_items
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND deleted_at IS NULL
             AND (
               ($4::text IS NOT NULL AND idempotency_key = $4)
               OR ($5::text IS NOT NULL AND legacy_provider = $5 AND legacy_provider_id = $6)
             )
           LIMIT 1`,
          [
            scope.userId,
            scope.personaId,
            scope.workspaceId,
            idempotencyKey,
            legacyProvider,
            legacyProviderId,
          ],
        );
        if (conflict.rows[0]?.id) return { id: conflict.rows[0].id, created: false };
        throw new Error('Canonical memory insert conflicted with an unknown unique constraint.');
      }
      await db.query(
        `INSERT INTO world_model_memory_item_history
          (memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
         VALUES ($1,$2,$3,$4,'create',$5,$6,$7::jsonb)`,
        [
          id,
          scope.userId,
          scope.personaId,
          scope.workspaceId,
          version,
          input.content,
          JSON.stringify(inputMetadata),
        ],
      );
      return { id: inserted.rows[0].id, created: true };
    }, scope);

    return canonical;
  }

  async searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]> {
    const scope = scopeFrom(input);
    const limit = safePageSize(Number(input.limit));
    return runWithWorldModelScope(scope, async () => {
      const provider = getConfiguredEmbeddingProvider();
      if (provider && input.query.trim()) {
        try {
          const queryEmbedding = await provider.generateEmbedding(input.query);
          const vectorHits = await vectorSearch(
            queryEmbedding,
            scope.userId,
            scope.personaId,
            scope.workspaceId,
            Math.max(20, Math.min(100, limit * 5)),
            0.2,
          );
          const relevant = vectorHits.filter((hit) => hit.targetType === 'memory');
          if (relevant.length > 0) {
            const ids = relevant.map((hit) => hit.targetId);
            const rows = await getWorldModelDb().query<CanonicalMemoryRow>(
              `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                      importance, confidence, lifecycle_status, version, metadata,
                      idempotency_key, legacy_provider, legacy_provider_id,
                      created_at, updated_at
               FROM world_model_memory_items
               WHERE id::text = ANY($1::text[])
                 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
                 AND deleted_at IS NULL`,
              [ids, scope.userId, scope.personaId, scope.workspaceId],
            );
            const byId = new Map(rows.rows.map((row) => [row.id, row]));
            return relevant
              .map((hit) => {
                const row = byId.get(hit.targetId);
                return row ? toRecord(row, hit.similarity) : null;
              })
              .filter((record): record is Mem0MemoryRecord => Boolean(record))
              .slice(0, limit);
          }
        } catch (error) {
          console.warn(
            '[memory:postgres] semantic search unavailable; using lexical search:',
            error,
          );
        }
      }

      const query = input.query.trim();
      const result = await getWorldModelDb().query<CanonicalMemoryRow>(
        `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                importance, confidence, lifecycle_status, version, metadata,
                idempotency_key, legacy_provider, legacy_provider_id,
                created_at, updated_at
         FROM world_model_memory_items
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND deleted_at IS NULL
           AND ($4 = '' OR content ILIKE '%' || $4 || '%'
                OR to_tsvector('simple', content) @@ plainto_tsquery('simple', $4))
         ORDER BY updated_at DESC
         LIMIT $5`,
        [scope.userId, scope.personaId, scope.workspaceId, query, limit],
      );
      return result.rows.map((row) => toRecord(row, query ? 0.5 : null));
    });
  }

  async listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult> {
    const page = safePage(input.page);
    const pageSize = safePageSize(input.pageSize);
    const scope = scopeFrom({
      userId: input.userId,
      personaId: input.personaId ?? '',
      workspaceId: input.workspaceId,
    });
    return runWithWorldModelScope(scope, async () => {
      const filters = [
        'user_id = $1',
        'persona_id = $2',
        'workspace_id = $3',
        'deleted_at IS NULL',
      ];
      const values: unknown[] = [scope.userId, scope.personaId, scope.workspaceId];
      let next = 4;
      if (input.query?.trim()) {
        filters.push(`content ILIKE '%' || $${next} || '%'`);
        values.push(input.query.trim());
        next += 1;
      }
      if (input.type?.trim()) {
        filters.push(`memory_type = $${next}`);
        values.push(input.type.trim());
        next += 1;
      }
      const where = filters.join(' AND ');
      const count = await getWorldModelDb().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM world_model_memory_items WHERE ${where}`,
        values,
      );
      values.push((page - 1) * pageSize, pageSize);
      const rows = await getWorldModelDb().query<CanonicalMemoryRow>(
        `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                importance, confidence, lifecycle_status, version, metadata,
                idempotency_key, legacy_provider, legacy_provider_id,
                created_at, updated_at
         FROM world_model_memory_items
         WHERE ${where}
         ORDER BY updated_at DESC, id ASC
         OFFSET $${next} LIMIT $${next + 1}`,
        values,
      );
      return {
        memories: rows.rows.map((row) => toRecord(row)),
        total: Number(count.rows[0]?.count ?? 0),
        page,
        pageSize,
      };
    });
  }

  async getMemory(id: string, scope?: Mem0Scope): Promise<Mem0MemoryRecord | null> {
    const resolved = scope ? scopeFrom(scope) : undefined;
    const execute = async (): Promise<Mem0MemoryRecord | null> => {
      const scopeClause = resolved
        ? 'AND user_id = $2 AND persona_id = $3 AND workspace_id = $4'
        : '';
      const result = await getWorldModelDb().query<CanonicalMemoryRow>(
        `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                importance, confidence, lifecycle_status, version, metadata,
                idempotency_key, legacy_provider, legacy_provider_id,
                created_at, updated_at
         FROM world_model_memory_items
         WHERE id = $1 ${scopeClause} AND deleted_at IS NULL LIMIT 1`,
        resolved ? [id, resolved.userId, resolved.personaId, resolved.workspaceId] : [id],
      );
      return result.rows[0] ? toRecord(result.rows[0]) : null;
    };
    return resolved ? runWithWorldModelScope(resolved, execute) : execute();
  }

  async getMemoryHistory(id: string, scope?: Mem0Scope): Promise<Mem0HistoryEntry[]> {
    const resolved = scope ? scopeFrom(scope) : undefined;
    const execute = async (): Promise<Mem0HistoryEntry[]> => {
      const scopeClause = resolved
        ? 'AND user_id = $2 AND persona_id = $3 AND workspace_id = $4'
        : '';
      const result = await getWorldModelDb().query<CanonicalHistoryRow>(
        `SELECT action, version, content, metadata, created_at
         FROM world_model_memory_item_history
         WHERE memory_id = $1 ${scopeClause}
         ORDER BY version ASC, created_at ASC`,
        resolved ? [id, resolved.userId, resolved.personaId, resolved.workspaceId] : [id],
      );
      return result.rows.map(historyEntry);
    };
    return resolved ? runWithWorldModelScope(resolved, execute) : execute();
  }

  async updateMemory(id: string, input: Mem0MemoryInput, scope?: Mem0Scope): Promise<void> {
    const resolved = scopeFromMemoryInput(input, scope);
    const inputMetadata = metadata(input.metadata);
    await withWorldModelTransaction(async (db) => {
      const current = await db.query<CanonicalMemoryRow>(
        `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                importance, confidence, lifecycle_status, version, metadata,
                idempotency_key, legacy_provider, legacy_provider_id,
                created_at, updated_at
         FROM world_model_memory_items
         WHERE id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
           AND deleted_at IS NULL
         FOR UPDATE`,
        [id, resolved.userId, resolved.personaId, resolved.workspaceId],
      );
      const row = current.rows[0];
      if (!row) throw new Error(`Memory node not found: ${id}`);
      const suppliedExpectedVersion = Number(inputMetadata.expectedVersion);
      const expectedVersion = Number.isFinite(suppliedExpectedVersion)
        ? Math.floor(suppliedExpectedVersion)
        : Number(row.version);
      if (expectedVersion !== Number(row.version)) {
        throw new MemoryVersionConflictError(Number(row.version));
      }
      const version = Number(row.version) + 1;
      const memoryType = text(inputMetadata.type) || row.memory_type;
      const importance = Math.min(
        5,
        Math.max(1, Math.round(Number(inputMetadata.importance) || Number(row.importance))),
      );
      const confidence = Math.min(
        1,
        Math.max(0.1, Number(inputMetadata.confidence) || Number(row.confidence)),
      );
      const lifecycleStatus = text(inputMetadata.lifecycleStatus) || row.lifecycle_status;
      const persistedMetadata = { ...inputMetadata };
      delete persistedMetadata.expectedVersion;
      await db.query(
        `UPDATE world_model_memory_items
         SET memory_type = $1, content = $2, importance = $3, confidence = $4,
             lifecycle_status = $5, version = $6, metadata = $7::jsonb, updated_at = now()
        WHERE id = $8 AND version = $9`,
        [
          memoryType,
          input.content,
          importance,
          confidence,
          lifecycleStatus,
          version,
          JSON.stringify(persistedMetadata),
          id,
          expectedVersion,
        ],
      );
      const updated = await db.query(
        `SELECT 1 FROM world_model_memory_items
         WHERE id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4
           AND version = $5`,
        [id, resolved.userId, resolved.personaId, resolved.workspaceId, version],
      );
      if (updated.rowCount !== 1) {
        throw new MemoryVersionConflictError(Number(row.version));
      }
      await db.query(
        `INSERT INTO world_model_memory_item_history
          (memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
         VALUES ($1,$2,$3,$4,'update',$5,$6,$7::jsonb)`,
        [
          id,
          resolved.userId,
          resolved.personaId,
          resolved.workspaceId,
          version,
          input.content,
          JSON.stringify(persistedMetadata),
        ],
      );
    }, resolved);
  }

  async deleteMemory(id: string, scope?: Mem0Scope): Promise<void> {
    const resolved = scope ? scopeFrom(scope) : undefined;
    if (!resolved) {
      throw new Error('Scoped canonical memory deletion requires user, persona, and workspace.');
    }
    const execute = async (): Promise<void> => {
      await withWorldModelTransaction(async (db) => {
        const current = await db.query<CanonicalMemoryRow>(
          `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                  importance, confidence, lifecycle_status, version, metadata,
                  idempotency_key, legacy_provider, legacy_provider_id,
                  created_at, updated_at
           FROM world_model_memory_items
           WHERE id = $1 ${resolved ? 'AND user_id = $2 AND persona_id = $3 AND workspace_id = $4' : ''}
             AND deleted_at IS NULL
           FOR UPDATE`,
          resolved ? [id, resolved.userId, resolved.personaId, resolved.workspaceId] : [id],
        );
        const row = current.rows[0];
        if (!row) throw new Error(`Memory node not found: ${id}`);
        const nextVersion = Number(row.version) + 1;
        const rowScope = resolved ?? {
          userId: row.user_id,
          personaId: row.persona_id,
          workspaceId: row.workspace_id,
        };
        const nextMetadata = {
          ...metadata(row.metadata),
          lifecycleStatus: 'deleted',
          version: nextVersion,
        };
        await db.query(
          `UPDATE world_model_memory_items
           SET deleted_at = now(), version = $1, metadata = $2::jsonb, updated_at = now()
           WHERE id = $3 AND user_id = $4 AND persona_id = $5 AND workspace_id = $6`,
          [
            nextVersion,
            JSON.stringify(nextMetadata),
            id,
            rowScope.userId,
            rowScope.personaId,
            rowScope.workspaceId,
          ],
        );
        await db.query(
          `INSERT INTO world_model_memory_item_history
            (memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
           VALUES ($1,$2,$3,$4,'delete',$5,$6,$7::jsonb)`,
          [
            id,
            rowScope.userId,
            rowScope.personaId,
            rowScope.workspaceId,
            nextVersion,
            row.content,
            JSON.stringify(nextMetadata),
          ],
        );
        await db.query(
          `DELETE FROM world_model_embeddings
           WHERE target_type = 'memory' AND target_id = $1
             AND user_id = $2 AND persona_id = $3 AND workspace_id = $4`,
          [id, rowScope.userId, rowScope.personaId, rowScope.workspaceId],
        );
      }, resolved);
    };
    return execute();
  }

  async deleteMemoriesByFilter(input: {
    userId: string;
    personaId: string;
    workspaceId?: string;
  }): Promise<number> {
    const scope = scopeFrom(input);
    return withWorldModelTransaction(async (db) => {
      const current = await db.query<CanonicalMemoryRow>(
        `SELECT id, user_id, persona_id, workspace_id, memory_type, content,
                importance, confidence, lifecycle_status, version, metadata,
                idempotency_key, legacy_provider, legacy_provider_id,
                created_at, updated_at
         FROM world_model_memory_items
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND deleted_at IS NULL
         FOR UPDATE`,
        [scope.userId, scope.personaId, scope.workspaceId],
      );
      for (const row of current.rows) {
        const nextVersion = Number(row.version) + 1;
        const nextMetadata = {
          ...metadata(row.metadata),
          lifecycleStatus: 'deleted',
          version: nextVersion,
        };
        await db.query(
          `UPDATE world_model_memory_items
           SET deleted_at = now(), version = $1, metadata = $2::jsonb, updated_at = now()
           WHERE id = $3 AND user_id = $4 AND persona_id = $5 AND workspace_id = $6`,
          [
            nextVersion,
            JSON.stringify(nextMetadata),
            row.id,
            scope.userId,
            scope.personaId,
            scope.workspaceId,
          ],
        );
        await db.query(
          `INSERT INTO world_model_memory_item_history
            (memory_id, user_id, persona_id, workspace_id, action, version, content, metadata)
           VALUES ($1,$2,$3,$4,'delete',$5,$6,$7::jsonb)`,
          [
            row.id,
            scope.userId,
            scope.personaId,
            scope.workspaceId,
            nextVersion,
            row.content,
            JSON.stringify(nextMetadata),
          ],
        );
      }
      if (current.rows.length > 0) {
        await db.query(
          `DELETE FROM world_model_embeddings WHERE target_type = 'memory' AND user_id = $1 AND persona_id = $2 AND workspace_id = $3`,
          [scope.userId, scope.personaId, scope.workspaceId],
        );
      }
      return current.rows.length;
    }, scope);
  }

  async countMemories(input: {
    userId?: string;
    personaId?: string;
    workspaceId?: string;
  }): Promise<number> {
    const userId = text(input.userId);
    if (!userId) return 0;
    const scope = input.personaId
      ? scopeFrom({ userId, personaId: input.personaId, workspaceId: input.workspaceId })
      : undefined;
    const execute = async (): Promise<number> => {
      const result = await getWorldModelDb().query<{ count: string }>(
        'SELECT world_model_count_memory_items($1, $2, $3)::text AS count',
        [userId, input.personaId?.trim() || null, input.workspaceId?.trim() || null],
      );
      return Number(result.rows[0]?.count ?? 0);
    };
    return scope ? runWithWorldModelScope(scope, execute) : execute();
  }
}
