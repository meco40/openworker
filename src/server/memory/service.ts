import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type { Mem0Client, Mem0MemoryRecord } from '@/server/memory/mem0Client';
import type { MemoryFeedbackSignal, MemoryRecallResult, MemoryHistoryRecord } from './types';
import { MemoryVersionConflictError } from './errors';
import { toMemoryNode, toHistoryRecord } from './mappers/nodeMappers';
import { resolveUserId, asVersion } from './validators/typeValidators';
import { isNotFoundError, isLegacyDeleteNotFoundError } from './utils/errorDetection';
import { matchesQuery, matchesType } from './utils/queryUtils';
import { formatTimestamp } from './utils/timestamp';
import { storeMemory } from './operations/store';
import { recall, recallDetailed } from './operations/recall';
import { registerFeedback } from './operations/feedback';
import { bulkUpdate, bulkDelete, deleteByPersona } from './operations/bulk';

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

export class MemoryService {
  constructor(private readonly mem0Client: Mem0Client) {}

  private async resolveNodeVersion(nodeId: string, node: MemoryNode): Promise<number> {
    const metaVersion = Number(node.metadata?.version);
    if (Number.isFinite(metaVersion) && metaVersion >= 1) {
      return Math.floor(metaVersion);
    }
    try {
      const history = await this.mem0Client.getMemoryHistory(nodeId);
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
  ): Promise<MemoryNode> {
    return storeMemory(this.mem0Client, {
      personaId,
      type,
      content,
      importance,
      userId,
      metadata,
    });
  }

  async recallDetailed(
    personaId: string,
    query: string,
    limit = 3,
    userId?: string,
  ): Promise<MemoryRecallResult> {
    return recallDetailed(this.mem0Client, { personaId, query, limit, userId });
  }

  async recall(personaId: string, query: string, limit = 3, userId?: string): Promise<string> {
    return recall(this.mem0Client, { personaId, query, limit, userId });
  }

  async registerFeedback(
    personaId: string,
    nodeIds: string[],
    signal: MemoryFeedbackSignal,
    userId?: string,
  ): Promise<number> {
    return registerFeedback(this.mem0Client, { personaId, nodeIds, signal, userId });
  }

  async snapshot(personaId?: string, userId?: string): Promise<MemoryNode[]> {
    const scopedUserId = resolveUserId(userId);
    const pageSize = 200;
    const maxPages = 200;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    const nodes: MemoryNode[] = [];

    while (page <= maxPages && nodes.length < total) {
      const listed = await this.mem0Client.listMemories({
        userId: scopedUserId,
        personaId,
        page,
        pageSize,
      });
      const mapped = listed.memories.map((record) => toMemoryNode(record));
      nodes.push(...mapped);
      total = Math.max(0, listed.total);
      if (mapped.length === 0) break;
      if (nodes.length >= total) break;
      page += 1;
    }

    return nodes;
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
  ): Promise<{
    nodes: MemoryNode[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const scopedUserId = resolveUserId(userId);
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));

    const listed = await this.mem0Client.listMemories({
      userId: scopedUserId,
      personaId,
      page,
      pageSize,
      query: input.query?.trim() || undefined,
      type: input.type,
    });

    const filteredNodes = listed.memories
      .map((record) => toMemoryNode(record))
      .filter((node) => matchesQuery(node, input.query))
      .filter((node) => matchesType(node, input.type));

    const localFilteredOut = listed.memories.length !== filteredNodes.length;
    const total = localFilteredOut
      ? filteredNodes.length
      : Math.max(filteredNodes.length, listed.total);
    const safePageSize = Math.max(1, listed.pageSize);

    return {
      nodes: filteredNodes,
      pagination: {
        page: listed.page,
        pageSize: safePageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / safePageSize)),
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
    },
    userId?: string,
  ): Promise<MemoryNode | null> {
    const scopedUserId = resolveUserId(userId);

    let current: Mem0MemoryRecord | null = null;
    try {
      current = await this.mem0Client.getMemory(nodeId);
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
    const currentVersion = await this.resolveNodeVersion(nodeId, currentNode);
    const expectedVersion =
      input.expectedVersion === undefined ? undefined : asVersion(input.expectedVersion, NaN);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new MemoryVersionConflictError(currentVersion);
    }
    const nextVersion = currentVersion + 1;
    const nextMetadata: Record<string, unknown> = {
      ...(currentNode.metadata || {}),
      type: nextType,
      importance: nextImportance,
      confidence: nextConfidence,
      lastVerified: new Date().toISOString(),
      version: nextVersion,
      mem0Id: nodeId,
      source: 'mem0',
      memoryProvider: 'mem0',
    };

    await this.mem0Client.updateMemory(nodeId, {
      userId: scopedUserId,
      personaId,
      content: nextContent,
      metadata: nextMetadata,
    });

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
        latest = await this.mem0Client.getMemory(nodeId);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (latest) {
        const latestNode = toMemoryNode(latest);
        const latestVersion = await this.resolveNodeVersion(nodeId, latestNode);
        if (latestVersion !== nextVersion) {
          throw new MemoryVersionConflictError(latestVersion);
        }
        return {
          ...latestNode,
          metadata: {
            ...(latestNode.metadata || {}),
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
  ): Promise<MemoryNode | null> {
    const snapshot = await this.history(personaId, nodeId, userId);
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
    );
  }

  async history(
    personaId: string,
    nodeId: string,
    userId?: string,
  ): Promise<{ node: MemoryNode; entries: MemoryHistoryRecord[] } | null> {
    let current: Mem0MemoryRecord | null = null;
    try {
      current = await this.mem0Client.getMemory(nodeId);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    if (!current) return null;

    const node = toMemoryNode(current);
    const entries = await this.mem0Client.getMemoryHistory(nodeId).catch((error) => {
      if (isNotFoundError(error)) return [];
      throw error;
    });
    // Keep signature aligned with user-scoped service calls.
    void personaId;
    void userId;

    return {
      node,
      entries: entries.map((entry, index) => toHistoryRecord(entry, index)),
    };
  }

  async delete(personaId: string, nodeId: string, userId?: string): Promise<boolean> {
    const scopedUserId = resolveUserId(userId);
    try {
      await this.mem0Client.deleteMemory(nodeId);
      return true;
    } catch (error) {
      if (!isNotFoundError(error) && !isLegacyDeleteNotFoundError(error)) throw error;

      const nodes = await this.snapshot(personaId, scopedUserId);
      const rewritten = nodes.find((node) => {
        const sourceId = String(node.metadata?.mem0Id || '').trim();
        return sourceId === nodeId;
      });
      if (!rewritten) return false;

      try {
        await this.mem0Client.deleteMemory(rewritten.id);
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
  ): Promise<number> {
    return bulkUpdate((pid, nid, input, uid) => this.update(pid, nid, input, uid), {
      personaId,
      nodeIds,
      updates,
      userId,
    });
  }

  async bulkDelete(personaId: string, nodeIds: string[], userId?: string): Promise<number> {
    return bulkDelete((pid, nid, uid) => this.delete(pid, nid, uid), {
      personaId,
      nodeIds,
      userId,
    });
  }

  async deleteByPersona(personaId: string, userId?: string): Promise<number> {
    return deleteByPersona(this.mem0Client, personaId, userId);
  }
}
