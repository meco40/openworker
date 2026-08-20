import { randomUUID } from 'node:crypto';
import type { MemoryNode, MemoryType } from '@/core/memory/types';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import type {
  Mem0Client,
  Mem0HistoryEntry,
  Mem0ListInput,
  Mem0ListMemoryResult,
  Mem0MemoryInput,
  Mem0MemoryRecord,
  Mem0SearchHit,
  Mem0SearchInput,
} from '@/server/memory/mem0';
import { SqliteMemoryRepository } from '@/server/memory/sqliteMemoryRepository';
import type { MemoryNodeWithScope } from '@/server/memory/sqliteMemoryRepository';

function resolveUserId(userId: string): string {
  const normalized = String(userId || '').trim();
  return normalized || LEGACY_LOCAL_USER_ID;
}

function toRecord(scoped: MemoryNodeWithScope, score: number | null = null): Mem0MemoryRecord {
  const verified = String(scoped.node.metadata?.lastVerified || '').trim();
  const updatedAt = verified || scoped.node.timestamp || new Date().toISOString();
  return {
    id: scoped.node.id,
    content: scoped.node.content,
    score,
    metadata: {
      ...scoped.node.metadata,
      type: scoped.node.type,
      importance: scoped.node.importance,
      confidence: scoped.node.confidence,
      source: 'sqlite',
      memoryProvider: 'sqlite',
      mem0Id: scoped.node.id,
    },
    createdAt: updatedAt,
    updatedAt,
  };
}

function matchesWorkspace(entry: MemoryNodeWithScope, workspaceId?: string): boolean {
  if (workspaceId === undefined) return true;
  return String(entry.node.metadata?.workspaceId || '') === workspaceId;
}

function nodeFromInput(id: string, input: Mem0MemoryInput): MemoryNode {
  const metadata = input.metadata || {};
  const type = String(metadata.type || 'fact') as MemoryType;
  const importance = Number(metadata.importance);
  const confidence = Number(metadata.confidence);
  const timestamp = String(metadata.lastVerified || new Date().toISOString());
  return {
    id,
    type,
    content: input.content,
    embedding: [],
    importance: Number.isFinite(importance) ? importance : 3,
    confidence: Number.isFinite(confidence) ? confidence : 0.3,
    timestamp,
    metadata: {
      ...metadata,
      source: 'sqlite',
      memoryProvider: 'sqlite',
      mem0Id: id,
    },
  };
}

function scoreContent(content: string, query: string): number {
  const terms = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return 0;
  const normalized = content.toLocaleLowerCase();
  const matches = terms.filter((term) => normalized.includes(term)).length;
  return matches / terms.length;
}

/**
 * Local durable fallback implementing the same contract as the Mem0 client.
 * It intentionally provides deterministic lexical search; semantic recall is
 * unavailable without an embedding service and must not be fabricated.
 */
export class SqliteMemoryClient implements Mem0Client {
  readonly provider = 'sqlite' as const;

  constructor(private readonly repository = new SqliteMemoryRepository()) {}

  async addMemory(input: Mem0MemoryInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.repository.insertNode(input.personaId, nodeFromInput(id, input), input.userId);
    return { id };
  }

  async searchMemories(input: Mem0SearchInput): Promise<Mem0SearchHit[]> {
    const records = this.repository
      .listAllNodesWithScope(resolveUserId(input.userId))
      .filter((entry) => entry.personaId === input.personaId)
      .filter((entry) => matchesWorkspace(entry, input.workspaceId))
      .map((entry) => ({ entry, score: scoreContent(entry.node.content, input.query) }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(b.entry.node.metadata?.lastVerified || '').localeCompare(
            String(a.entry.node.metadata?.lastVerified || ''),
          ),
      )
      .slice(0, Math.max(1, Math.min(200, Math.floor(input.limit))))
      .map(({ entry, score }) => toRecord(entry, score));
    return records;
  }

  async listMemories(input: Mem0ListInput): Promise<Mem0ListMemoryResult> {
    const userId = resolveUserId(input.userId);
    if (input.personaId) {
      if (input.workspaceId !== undefined) {
        const all = this.repository
          .listAllNodesWithScope(userId)
          .filter((entry) => entry.personaId === input.personaId)
          .filter((entry) => matchesWorkspace(entry, input.workspaceId))
          .filter((entry) => !input.type || entry.node.type === input.type)
          .filter(
            (entry) =>
              !input.query || entry.node.content.toLowerCase().includes(input.query.toLowerCase()),
          );
        const page = Math.max(1, Math.floor(input.page));
        const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
        const start = (page - 1) * pageSize;
        return {
          memories: all.slice(start, start + pageSize).map((entry) => toRecord(entry)),
          total: all.length,
          page,
          pageSize,
        };
      }
      const page = this.repository.listNodesPage(
        input.personaId,
        {
          page: input.page,
          pageSize: input.pageSize,
          query: input.query,
          type: input.type as MemoryType | undefined,
        },
        userId,
      );
      return {
        memories: page.nodes.map((node) => toRecord({ node, userId, personaId: input.personaId! })),
        total: page.total,
        page: input.page,
        pageSize: input.pageSize,
      };
    }

    const all = this.repository
      .listAllNodesWithScope(userId)
      .filter((entry) => matchesWorkspace(entry, input.workspaceId));
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const start = (page - 1) * pageSize;
    return {
      memories: all.slice(start, start + pageSize).map((entry) => toRecord(entry)),
      total: all.length,
      page,
      pageSize,
    };
  }

  async getMemory(
    id: string,
    scope?: { userId: string; personaId: string; workspaceId?: string },
  ): Promise<Mem0MemoryRecord | null> {
    const found = this.repository.getNodeById(id);
    if (
      found &&
      scope &&
      (found.userId !== resolveUserId(scope.userId) ||
        found.personaId !== scope.personaId ||
        !matchesWorkspace(found, scope.workspaceId))
    ) {
      return null;
    }
    return found ? toRecord(found) : null;
  }

  async getMemoryHistory(id: string): Promise<Mem0HistoryEntry[]> {
    return this.repository.listNodeHistory(id).map((entry) => ({
      action: entry.action,
      timestamp: entry.timestamp,
      content: entry.content,
      metadata: entry.metadata,
      raw: {},
    }));
  }

  async updateMemory(id: string, input: Mem0MemoryInput): Promise<void> {
    const found = this.repository.getNodeById(id);
    if (!found) throw new Error(`Memory node not found: ${id}`);
    if (
      found.userId !== resolveUserId(input.userId) ||
      found.personaId !== input.personaId ||
      !matchesWorkspace(found, input.workspaceId)
    ) {
      throw new Error('Memory node scope mismatch.');
    }
    this.repository.updateNode(input.personaId, nodeFromInput(id, input), input.userId);
  }

  async deleteMemory(
    id: string,
    scope?: { userId: string; personaId: string; workspaceId?: string },
  ): Promise<void> {
    const found = this.repository.getNodeById(id);
    if (!found) throw new Error(`Memory node not found: ${id}`);
    if (
      scope &&
      (found.userId !== resolveUserId(scope.userId) ||
        found.personaId !== scope.personaId ||
        !matchesWorkspace(found, scope.workspaceId))
    ) {
      throw new Error('Memory node scope mismatch.');
    }
    this.repository.deleteNode(found.personaId, id, found.userId);
  }

  async deleteMemoriesByFilter(input: {
    userId: string;
    personaId: string;
    workspaceId?: string;
  }): Promise<number> {
    if (input.workspaceId === undefined) {
      return this.repository.deleteByPersona(input.personaId, input.userId);
    }
    const entries = this.repository
      .listAllNodesWithScope(resolveUserId(input.userId))
      .filter((entry) => entry.personaId === input.personaId)
      .filter((entry) => matchesWorkspace(entry, input.workspaceId));
    for (const entry of entries)
      this.repository.deleteNode(entry.personaId, entry.node.id, entry.userId);
    return entries.length;
  }
}
