import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type { Mem0Client, Mem0MemoryRecord, Mem0Scope } from '@/server/memory/mem0';
import type { MemoryFeedbackSignal, MemoryRecallResult, MemoryHistoryRecord } from './types';
import { MemoryVersionConflictError } from './errors';
import { toMemoryNode, toHistoryRecord } from './mappers/nodeMappers';
import { resolveUserId, asVersion } from './validators/typeValidators';
import { isNotFoundError, isLegacyDeleteNotFoundError } from './utils/errorDetection';
import { matchesQuery, matchesType } from './utils/queryUtils';
import { formatTimestamp } from './utils/timestamp';
import { storeMemory as storeMemoryOperation } from './operations/store';
import { recallDetailed } from './operations/recall';
import { registerFeedback } from './operations/feedback';
import { bulkUpdate, bulkDelete, deleteByPersona } from './operations/bulk';
import {
  publishMemoryLifecycleChange,
  type LifecycleSignal,
  type LifecycleStatus,
} from './lifecycle';
import { isMem0TypeAllowed, allowedMem0Types } from '@/server/world-model/mem0Policy';

// Re-export types and error for public API
export type {
  MemoryFeedbackSignal,
  MemoryRecallMatch,
  MemoryRecallResult,
  MemoryHistoryRecord,
  MemorySubject,
} from './types';
export { MemoryVersionConflictError } from './errors';
export { detectMemorySubject } from './subject/detector';

export interface MemoryStoreInput {
  personaId: string;
  workspaceId?: string;
  type: MemoryType;
  content: string;
  importance: number;
  userId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class MemoryService {
  private readonly idempotencyLocks = new Map<string, Promise<MemoryNode>>();
  private readonly updateLocks = new Map<string, Promise<MemoryNode | null>>();

  constructor(private readonly mem0Client: Mem0Client) {}

  private provider(): NonNullable<Mem0Client['provider']> {
    return this.mem0Client.provider ?? 'mem0';
  }

  private rankNode(node: MemoryNode): number {
    const timestamp = String(node.metadata?.lastVerified || '').trim();
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async listAllFilteredNodes(
    personaId: string | undefined,
    userId: string | undefined,
    workspaceId: string | undefined,
    input: { query?: string; type?: MemoryType },
  ): Promise<MemoryNode[]> {
    const scopedUserId = resolveUserId(userId);
    const apiPageSize = 200;
    const nodes: MemoryNode[] = [];
    let page = 1;
    let fetchedRecords = 0;
    let reportedTotal = Number.POSITIVE_INFINITY;

    while (page <= 10_000) {
      const listed = await this.mem0Client.listMemories({
        userId: scopedUserId,
        personaId,
        workspaceId,
        page,
        pageSize: apiPageSize,
        query: input.query?.trim() || undefined,
        type: input.type,
      });
      const mapped = listed.memories.map((record) => toMemoryNode(record));
      nodes.push(
        ...mapped
          .filter((node) => matchesQuery(node, input.query))
          .filter((node) => matchesType(node, input.type)),
      );
      fetchedRecords += listed.memories.length;
      reportedTotal = Number.isFinite(listed.total)
        ? Math.max(0, Math.floor(listed.total))
        : fetchedRecords;

      if (listed.memories.length === 0 || fetchedRecords >= reportedTotal) break;
      page += 1;
    }

    if (page > 10_000) {
      throw new Error('Mem0 pagination exceeded the safety limit while listing memories.');
    }

    return nodes;
  }

  /**
   * Resolve a single node through the already scoped list API. Mem0's direct
   * GET/history/delete endpoints accept only an opaque id, so this lookup is
   * the application-owned defense-in-depth boundary for tenant isolation.
   */
  private async findScopedRecord(
    personaId: string,
    nodeId: string,
    userId?: string,
    workspaceId?: string,
  ): Promise<Mem0MemoryRecord | null> {
    const scopedUserId = resolveUserId(userId);
    const scope: Mem0Scope = { userId: scopedUserId, personaId, workspaceId };
    if (this.provider() === 'postgres') {
      return this.mem0Client.getMemory(nodeId, scope);
    }
    let page = 1;
    let fetchedRecords = 0;
    while (page <= 10_000) {
      const listed = await this.mem0Client.listMemories({
        userId: scopedUserId,
        personaId,
        workspaceId,
        page,
        pageSize: 200,
      });
      const match = listed.memories.find((record) => record.id === nodeId);
      if (match) return match;
      fetchedRecords += listed.memories.length;
      if (listed.memories.length === 0 || fetchedRecords >= listed.total) return null;
      page += 1;
    }
    throw new Error('Mem0 pagination exceeded the safety limit while resolving a memory node.');
  }

  private async findByIdempotencyKey(
    personaId: string,
    userId: string | undefined,
    idempotencyKey: string,
    workspaceId?: string,
  ): Promise<MemoryNode | null> {
    const scopedUserId = resolveUserId(userId);
    let page = 1;
    let fetchedRecords = 0;
    while (page <= 10_000) {
      const listed = await this.mem0Client.listMemories({
        userId: scopedUserId,
        personaId,
        workspaceId,
        page,
        pageSize: 200,
      });
      const match = listed.memories.find(
        (record) => String(record.metadata?.idempotencyKey || '').trim() === idempotencyKey,
      );
      if (match) return toMemoryNode(match);
      fetchedRecords += listed.memories.length;
      if (listed.memories.length === 0 || fetchedRecords >= listed.total) return null;
      page += 1;
    }
    throw new Error('Mem0 pagination exceeded the safety limit while resolving idempotency.');
  }

  private async resolveNodeVersion(
    nodeId: string,
    node: MemoryNode,
    scope?: Mem0Scope,
  ): Promise<number> {
    const metaVersion = Number(node.metadata?.version);
    if (Number.isFinite(metaVersion) && metaVersion >= 1) {
      return Math.floor(metaVersion);
    }
    try {
      const history = await this.mem0Client.getMemoryHistory(nodeId, scope);
      if (history.length > 0) return history.length;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return 1;
  }

  async store(
    personaId: string,
    type: MemoryType,
    content: string,
    importance: number,
    userId?: string,
    metadata?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MemoryNode> {
    return this.storeMemory({
      personaId,
      type,
      content,
      importance,
      userId,
      metadata,
      signal,
    });
  }

  /** Canonical named-argument API for new production callers. */
  async storeMemory(input: MemoryStoreInput): Promise<MemoryNode> {
    if (this.provider() === 'mem0' && !isMem0TypeAllowed(input.type)) {
      throw new Error(
        `[memory] type '${input.type}' is blocked by the active World-Model Mem0 policy`,
      );
    }
    const metadata = input.metadata || {};
    const idempotencyKey = String(metadata.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      return storeMemoryOperation(this.mem0Client, input);
    }

    const lockKey = `${resolveUserId(input.userId)}:${input.personaId}:${input.workspaceId || ''}:${idempotencyKey}`;
    const running = this.idempotencyLocks.get(lockKey);
    if (running) return running;

    const operation = (async () => {
      const existing = await this.findByIdempotencyKey(
        input.personaId,
        input.userId,
        idempotencyKey,
        input.workspaceId,
      );
      return existing || storeMemoryOperation(this.mem0Client, input);
    })();
    this.idempotencyLocks.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (this.idempotencyLocks.get(lockKey) === operation) {
        this.idempotencyLocks.delete(lockKey);
      }
    }
  }

  async recallDetailed(
    personaId: string,
    query: string,
    limit = 3,
    userId?: string,
    options?: {
      mode?: 'semantic' | 'lexical';
      memoryTypes?: import('@/core/memory/types').MemoryType[];
      workspaceId?: string;
    },
  ): Promise<MemoryRecallResult> {
    const memoryTypes =
      options?.memoryTypes ??
      (this.provider() === 'mem0' ? (allowedMem0Types() as MemoryType[]) : undefined);
    return recallDetailed(this.mem0Client, {
      personaId,
      query,
      limit,
      userId,
      ...options,
      memoryTypes,
    });
  }

  async recall(
    personaId: string,
    query: string,
    limit = 3,
    userId?: string,
    workspaceId?: string,
  ): Promise<string> {
    const result = await this.recallDetailed(personaId, query, limit, userId, { workspaceId });
    return result.context;
  }

  async registerFeedback(
    personaId: string,
    nodeIds: string[],
    signal: MemoryFeedbackSignal,
    userId?: string,
    workspaceId?: string,
  ): Promise<number> {
    const ownedNodeIds: string[] = [];
    for (const nodeId of Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))) {
      const owned = await this.findScopedRecord(personaId, nodeId, userId, workspaceId);
      if (owned) ownedNodeIds.push(nodeId);
    }
    return registerFeedback(this.mem0Client, {
      personaId,
      nodeIds: ownedNodeIds,
      signal,
      userId,
      workspaceId,
    });
  }

  async snapshotWithMeta(
    personaId?: string,
    userId?: string,
    workspaceId?: string,
  ): Promise<{ nodes: MemoryNode[]; total: number; truncated: boolean }> {
    const nodes = await this.listAllFilteredNodes(personaId, userId, workspaceId, {});
    return { nodes, total: nodes.length, truncated: false };
  }

  async snapshot(personaId?: string, userId?: string, workspaceId?: string): Promise<MemoryNode[]> {
    return (await this.snapshotWithMeta(personaId, userId, workspaceId)).nodes;
  }

  async count(personaId?: string, userId?: string, workspaceId?: string): Promise<number> {
    const countMemories = (
      this.mem0Client as Mem0Client & {
        countMemories?: (input: {
          userId?: string;
          personaId?: string;
          workspaceId?: string;
        }) => Promise<number>;
      }
    ).countMemories;
    if (countMemories) return countMemories({ userId, personaId, workspaceId });

    const scopedUserId = resolveUserId(userId);
    const listed = await this.mem0Client.listMemories({
      userId: scopedUserId,
      personaId,
      workspaceId,
      page: 1,
      pageSize: 1,
    });
    return Number.isFinite(listed.total) && listed.total >= 0
      ? Math.floor(listed.total)
      : listed.memories.length;
  }

  async listPage(
    personaId: string,
    input: {
      page: number;
      pageSize: number;
      query?: string;
      type?: MemoryType;
    },
    userId?: string,
    workspaceId?: string,
  ): Promise<{
    nodes: MemoryNode[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const listed = await this.mem0Client.listMemories({
      userId: resolveUserId(userId),
      personaId,
      workspaceId,
      page,
      pageSize,
      query: input.query?.trim() || undefined,
      type: input.type,
    });
    const mapped = listed.memories
      .map((record) => toMemoryNode(record))
      .filter((node) => matchesQuery(node, input.query))
      .filter((node) => matchesType(node, input.type));
    const total = listed.memories.length === listed.total ? mapped.length : listed.total;

    return {
      nodes: mapped,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  async listPageAcrossScopes(
    personaId: string,
    userScopes: string[],
    input: { page: number; pageSize: number; query?: string; type?: MemoryType },
    workspaceId?: string,
  ): Promise<{
    nodes: MemoryNode[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const scopedNodes = await Promise.all(
      userScopes.map((scopeUserId) =>
        this.listAllFilteredNodes(personaId, scopeUserId, workspaceId, input),
      ),
    );
    const byId = new Map<string, MemoryNode>();
    for (const node of scopedNodes.flat()) {
      const existing = byId.get(node.id);
      if (!existing || this.rankNode(node) >= this.rankNode(existing)) {
        byId.set(node.id, node);
      }
    }

    const allNodes = Array.from(byId.values()).sort(
      (a, b) => this.rankNode(b) - this.rankNode(a) || a.id.localeCompare(b.id),
    );
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const offset = (page - 1) * pageSize;
    return {
      nodes: allNodes.slice(offset, offset + pageSize),
      pagination: {
        page,
        pageSize,
        total: allNodes.length,
        totalPages: Math.max(1, Math.ceil(allNodes.length / pageSize)),
      },
    };
  }

  async update(
    personaId: string,
    nodeId: string,
    input: {
      type?: MemoryType;
      content?: string;
      importance?: number;
      expectedVersion?: number;
      metadata?: Record<string, unknown>;
    },
    userId?: string,
    workspaceId?: string,
  ): Promise<MemoryNode | null> {
    const lockKey = `${resolveUserId(userId)}:${personaId}:${workspaceId || ''}:${nodeId}`;
    const running = this.updateLocks.get(lockKey);
    if (running) return running;
    const operation = this.updateUnlocked(personaId, nodeId, input, userId, workspaceId);
    this.updateLocks.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (this.updateLocks.get(lockKey) === operation) this.updateLocks.delete(lockKey);
    }
  }

  private async updateUnlocked(
    personaId: string,
    nodeId: string,
    input: {
      type?: MemoryType;
      content?: string;
      importance?: number;
      expectedVersion?: number;
      metadata?: Record<string, unknown>;
    },
    userId?: string,
    workspaceId?: string,
  ): Promise<MemoryNode | null> {
    const scopedUserId = resolveUserId(userId);

    let current: Mem0MemoryRecord | null = null;
    try {
      current = await this.findScopedRecord(personaId, nodeId, scopedUserId, workspaceId);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    if (!current) return null;

    const currentNode = toMemoryNode(current);
    const nextType = input.type ?? currentNode.type;
    const nextContent = input.content ?? currentNode.content;
    const nextImportance = input.importance ?? currentNode.importance;
    const nextConfidence = currentNode.confidence;
    const scope: Mem0Scope = {
      userId: scopedUserId,
      personaId,
      workspaceId: workspaceId ?? String(currentNode.metadata?.workspaceId || ''),
    };
    const currentVersion = await this.resolveNodeVersion(nodeId, currentNode, scope);
    const expectedVersion =
      input.expectedVersion === undefined ? undefined : asVersion(input.expectedVersion, NaN);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new MemoryVersionConflictError(currentVersion);
    }
    const nextVersion = currentVersion + 1;
    const memoryProvider = this.provider();
    const nextMetadata: Record<string, unknown> = {
      ...currentNode.metadata,
      ...input.metadata,
      type: nextType,
      importance: nextImportance,
      confidence: nextConfidence,
      lastVerified: new Date().toISOString(),
      version: nextVersion,
      mem0Id: nodeId,
      source: memoryProvider,
      memoryProvider,
    };

    const updateMetadata =
      memoryProvider === 'postgres'
        ? { ...nextMetadata, expectedVersion: currentVersion }
        : nextMetadata;
    await this.mem0Client.updateMemory(
      nodeId,
      {
        userId: scopedUserId,
        personaId,
        workspaceId: scope.workspaceId,
        content: nextContent,
        metadata: updateMetadata,
      },
      scope,
    );

    const lifecycleSignal = String(input.metadata?.lifecycleSignal || '').trim();
    if (lifecycleSignal) {
      publishMemoryLifecycleChange({
        memoryId: nodeId,
        userId: scopedUserId,
        personaId,
        status: String(nextMetadata.lifecycleStatus || 'new') as LifecycleStatus,
        signal: lifecycleSignal as LifecycleSignal,
        provider: memoryProvider,
      });
    }

    const updated: MemoryNode = {
      ...currentNode,
      id: nodeId,
      type: nextType,
      content: nextContent,
      importance: nextImportance,
      timestamp: formatTimestamp(),
      metadata: {
        ...nextMetadata,
        mem0Id: nodeId,
      },
    };

    if (expectedVersion !== undefined) {
      let latest: Mem0MemoryRecord | null = null;
      try {
        latest = await this.findScopedRecord(personaId, nodeId, scopedUserId, workspaceId);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (latest) {
        const latestNode = toMemoryNode(latest);
        const latestVersion = await this.resolveNodeVersion(nodeId, latestNode, scope);
        if (latestVersion !== nextVersion) {
          throw new MemoryVersionConflictError(latestVersion);
        }
        return {
          ...latestNode,
          metadata: {
            ...latestNode.metadata,
            version: latestVersion,
            mem0Id: nodeId,
          },
        };
      }
    }

    return updated;
  }

  async restoreFromHistory(
    personaId: string,
    nodeId: string,
    input: { restoreIndex: number; expectedVersion?: number },
    userId?: string,
    workspaceId?: string,
  ): Promise<MemoryNode | null> {
    const snapshot = await this.history(personaId, nodeId, userId, workspaceId);
    if (!snapshot) return null;

    const index = Math.floor(input.restoreIndex);
    if (!Number.isFinite(index) || index < 0 || index >= snapshot.entries.length) {
      throw new Error('Invalid restore index.');
    }
    const target = snapshot.entries[index];
    const restoredContent = String(target.content || '').trim();
    if (!restoredContent) {
      throw new Error('Selected history entry has no restorable content.');
    }

    return this.update(
      personaId,
      nodeId,
      {
        content: restoredContent,
        type: target.type,
        importance: target.importance,
        expectedVersion: input.expectedVersion,
      },
      userId,
      workspaceId,
    );
  }

  async history(
    personaId: string,
    nodeId: string,
    userId?: string,
    workspaceId?: string,
  ): Promise<{ node: MemoryNode; entries: MemoryHistoryRecord[] } | null> {
    let current: Mem0MemoryRecord | null = null;
    try {
      current = await this.findScopedRecord(personaId, nodeId, userId, workspaceId);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    if (!current) return null;

    const node = toMemoryNode(current);
    const entries = await this.mem0Client
      .getMemoryHistory(nodeId, {
        userId: resolveUserId(userId),
        personaId,
        workspaceId: workspaceId ?? String(node.metadata?.workspaceId || ''),
      })
      .catch((error) => {
        if (isNotFoundError(error)) return [];
        throw error;
      });
    return {
      node,
      entries: entries.map((entry, index) => toHistoryRecord(entry, index)),
    };
  }

  async delete(
    personaId: string,
    nodeId: string,
    userId?: string,
    workspaceId?: string,
  ): Promise<boolean> {
    const scopedUserId = resolveUserId(userId);
    const owned = await this.findScopedRecord(personaId, nodeId, scopedUserId, workspaceId);
    if (!owned) return false;
    try {
      await this.mem0Client.deleteMemory(nodeId, { userId: scopedUserId, personaId, workspaceId });
      return true;
    } catch (error) {
      if (!isNotFoundError(error) && !isLegacyDeleteNotFoundError(error)) throw error;

      const nodes = await this.snapshot(personaId, scopedUserId, workspaceId);
      const rewritten = nodes.find((node) => {
        const sourceId = String(node.metadata?.mem0Id || '').trim();
        return sourceId === nodeId;
      });
      if (!rewritten) return false;

      try {
        await this.mem0Client.deleteMemory(rewritten.id, {
          userId: scopedUserId,
          personaId,
          workspaceId,
        });
        return true;
      } catch (secondError) {
        if (isNotFoundError(secondError)) return false;
        throw secondError;
      }
    }
  }

  async bulkUpdate(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
    userId?: string,
    workspaceId?: string,
  ): Promise<number> {
    return bulkUpdate((pid, nid, input, uid, wid) => this.update(pid, nid, input, uid, wid), {
      personaId,
      nodeIds,
      updates,
      userId,
      workspaceId,
    });
  }

  async bulkDelete(
    personaId: string,
    nodeIds: string[],
    userId?: string,
    workspaceId?: string,
  ): Promise<number> {
    return bulkDelete((pid, nid, uid, wid) => this.delete(pid, nid, uid, wid), {
      personaId,
      nodeIds,
      userId,
      workspaceId,
    });
  }

  async deleteByPersona(personaId: string, userId?: string, workspaceId?: string): Promise<number> {
    return deleteByPersona(this.mem0Client, personaId, userId, workspaceId);
  }
}
