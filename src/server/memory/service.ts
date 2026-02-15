import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import type { Mem0Client, Mem0HistoryEntry, Mem0MemoryRecord, Mem0SearchHit } from './mem0Client';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

export type MemoryFeedbackSignal = 'positive' | 'negative';

export interface MemoryRecallMatch {
  node: MemoryNode;
  similarity: number;
  score: number;
}

export interface MemoryRecallResult {
  context: string;
  matches: MemoryRecallMatch[];
}

export interface MemoryHistoryRecord {
  index: number;
  action: string;
  timestamp: string;
  content?: string;
  type?: MemoryType;
  importance?: number;
  version?: number;
  metadata: Record<string, unknown>;
}

export class MemoryVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number, message = 'Memory version conflict. Reload and retry.') {
    super(message);
    this.name = 'MemoryVersionConflictError';
    this.currentVersion = currentVersion;
  }
}

const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 1.0;
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;
const FORGET_NEGATIVE_FEEDBACK_THRESHOLD = 3;
const FORGET_CONFIDENCE_THRESHOLD = 0.15;
const MEM0_SCORE_THRESHOLD = 0.45;

function resolveUserId(userId?: string): string {
  const normalized = String(userId || '').trim();
  return normalized || LEGACY_LOCAL_USER_ID;
}

function asMemoryType(value: unknown): MemoryType {
  const text = String(value || '').trim() as MemoryType;
  const allowed: MemoryType[] = [
    'fact',
    'preference',
    'avoidance',
    'lesson',
    'personality_trait',
    'workflow_pattern',
  ];
  return allowed.includes(text) ? text : 'fact';
}

function asImportance(value: unknown, fallback = 3): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, Math.round(parsed)));
}

function asConfidence(value: unknown, fallback = 0.5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, parsed));
}

function asFeedbackCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function asVersion(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function normalizeMem0Score(score: number | null): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0.75;
  if (score >= 0 && score <= 1) return score;
  if (score > 1 && score <= 100) return Math.min(1, score / 100);
  if (score < 0) return 0;
  return 0.75;
}

function formatTimestamp(input?: string): string {
  if (!input) {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return input;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toMemoryNode(record: Mem0MemoryRecord): MemoryNode {
  const metadata = record.metadata || {};
  return {
    id: record.id,
    type: asMemoryType(metadata.type),
    content: record.content,
    embedding: [],
    importance: asImportance(metadata.importance, 3),
    confidence: asConfidence(metadata.confidence, 0.5),
    timestamp: formatTimestamp(record.updatedAt || record.createdAt),
    metadata: {
      ...metadata,
      mem0Id: (typeof metadata.mem0Id === 'string' && metadata.mem0Id.trim()) || record.id,
      source: 'mem0',
      memoryProvider: 'mem0',
      lastVerified:
        (typeof metadata.lastVerified === 'string' && metadata.lastVerified) ||
        record.updatedAt ||
        record.createdAt ||
        new Date().toISOString(),
    },
  };
}

function toMemoryNodeFromHit(hit: Mem0SearchHit): MemoryNode {
  return toMemoryNode({
    id: hit.id,
    content: hit.content,
    score: hit.score,
    metadata: hit.metadata,
  });
}

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /http\s*404/i.test(message);
}

function isLegacyDeleteNotFoundError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!/http\s*500/i.test(message)) return false;
  return (
    (message.includes('nonetype') && message.includes('payload')) ||
    message.includes('memory not found') ||
    message.includes('not found')
  );
}

function matchesQuery(node: MemoryNode, query?: string): boolean {
  const needle = String(query || '')
    .trim()
    .toLowerCase();
  if (!needle) return true;
  return node.content.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle);
}

function matchesType(node: MemoryNode, type?: MemoryType): boolean {
  if (!type) return true;
  return node.type === type;
}

function asOptionalMemoryType(value: unknown): MemoryType | undefined {
  const text = String(value || '').trim() as MemoryType;
  const allowed: MemoryType[] = [
    'fact',
    'preference',
    'avoidance',
    'lesson',
    'personality_trait',
    'workflow_pattern',
  ];
  return allowed.includes(text) ? text : undefined;
}

function toHistoryRecord(entry: Mem0HistoryEntry, index: number): MemoryHistoryRecord {
  const metadata = entry.metadata || {};
  return {
    index,
    action: String(entry.action || 'unknown').toLowerCase(),
    timestamp: String(entry.timestamp || new Date().toISOString()),
    content: entry.content,
    type: asOptionalMemoryType(metadata.type),
    importance:
      metadata.importance === undefined ? undefined : asImportance(metadata.importance, 3),
    version: metadata.version === undefined ? index + 1 : asVersion(metadata.version, index + 1),
    metadata,
  };
}

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
  ): Promise<MemoryNode> {
    const scopedUserId = resolveUserId(userId);

    const result = await this.mem0Client.addMemory({
      userId: scopedUserId,
      personaId,
      content,
      metadata: {
        type,
        importance: asImportance(importance, 3),
        confidence: 0.3,
        version: 1,
        lastVerified: new Date().toISOString(),
      },
    });
    if (!result.id) {
      throw new Error('Mem0 store failed: response did not include memory id.');
    }

    return {
      id: result.id,
      type,
      content,
      embedding: [],
      importance: asImportance(importance, 3),
      confidence: 0.3,
      timestamp: formatTimestamp(),
      metadata: {
        mem0Id: result.id,
        source: 'mem0',
        memoryProvider: 'mem0',
        version: 1,
        lastVerified: new Date().toISOString(),
      },
    };
  }

  async recallDetailed(
    personaId: string,
    query: string,
    limit = 3,
    userId?: string,
  ): Promise<MemoryRecallResult> {
    const scopedUserId = resolveUserId(userId);
    const safeLimit = Math.max(1, limit);
    const hits = await this.mem0Client.searchMemories({
      userId: scopedUserId,
      personaId,
      query,
      limit: safeLimit,
    });

    let matches = hits
      .map((hit) => {
        const similarity = normalizeMem0Score(hit.score);
        return {
          node: toMemoryNodeFromHit(hit),
          similarity,
          score: similarity,
        };
      })
      .filter((entry) => entry.similarity >= MEM0_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, safeLimit);

    if (matches.length === 0) {
      const listed = await this.mem0Client.listMemories({
        userId: scopedUserId,
        personaId,
        page: 1,
        pageSize: Math.max(10, safeLimit),
        query: query.trim() || undefined,
      });

      const lowered = query.trim().toLowerCase();
      matches = listed.memories
        .map((record) => toMemoryNode(record))
        .filter((node) => {
          if (!lowered) return true;
          return node.content.toLowerCase().includes(lowered);
        })
        .slice(0, safeLimit)
        .map((node) => ({
          node,
          similarity: MEM0_SCORE_THRESHOLD,
          score: MEM0_SCORE_THRESHOLD,
        }));
    }

    const context = matches
      .map((result) => `[Type: ${result.node.type}] ${result.node.content}`)
      .join('\n');

    return {
      context: context || 'No relevant memories found.',
      matches,
    };
  }

  async recall(personaId: string, query: string, limit = 3, userId?: string): Promise<string> {
    const result = await this.recallDetailed(personaId, query, limit, userId);
    return result.context;
  }

  async registerFeedback(
    personaId: string,
    nodeIds: string[],
    signal: MemoryFeedbackSignal,
    userId?: string,
  ): Promise<number> {
    const scopedUserId = resolveUserId(userId);
    const ids = Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return 0;

    let changed = 0;
    for (const nodeId of ids) {
      let record: Mem0MemoryRecord | null = null;
      try {
        record = await this.mem0Client.getMemory(nodeId);
      } catch (error) {
        if (isNotFoundError(error)) continue;
        throw error;
      }
      if (!record) continue;

      const existingNode = toMemoryNode(record);
      const confidenceDelta = signal === 'positive' ? 0.15 : -0.2;
      const importanceDelta = signal === 'positive' ? 1 : -1;
      const nextFeedbackCount = asFeedbackCount(existingNode.metadata?.feedbackCount) + 1;
      const currentVersion = await this.resolveNodeVersion(nodeId, existingNode);
      const nextVersion = currentVersion + 1;
      const nextConfidence = Math.min(
        MAX_CONFIDENCE,
        Math.max(MIN_CONFIDENCE, existingNode.confidence + confidenceDelta),
      );
      const nextImportance = Math.min(
        MAX_IMPORTANCE,
        Math.max(MIN_IMPORTANCE, existingNode.importance + importanceDelta),
      );

      if (
        signal === 'negative' &&
        nextFeedbackCount >= FORGET_NEGATIVE_FEEDBACK_THRESHOLD &&
        nextConfidence <= FORGET_CONFIDENCE_THRESHOLD
      ) {
        await this.mem0Client.deleteMemory(nodeId);
        changed += 1;
        continue;
      }

      await this.mem0Client.updateMemory(nodeId, {
        userId: scopedUserId,
        personaId,
        content: existingNode.content,
        metadata: {
          ...(existingNode.metadata || {}),
          type: existingNode.type,
          importance: nextImportance,
          confidence: nextConfidence,
          lastVerified: new Date().toISOString(),
          lastFeedback: signal,
          feedbackCount: nextFeedbackCount,
          version: nextVersion,
          mem0Id: nodeId,
          source: 'mem0',
          memoryProvider: 'mem0',
        },
      });
      changed += 1;
    }

    return changed;
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
      importance: asImportance(nextImportance, currentNode.importance),
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
      importance: asImportance(nextImportance, currentNode.importance),
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
    let entries: Mem0HistoryEntry[] = [];
    try {
      entries = await this.mem0Client.getMemoryHistory(nodeId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
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
    let changed = 0;
    for (const nodeId of Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))) {
      const updated = await this.update(
        personaId,
        nodeId,
        {
          type: updates.type,
          importance: updates.importance,
        },
        userId,
      );
      if (updated) changed += 1;
    }
    return changed;
  }

  async bulkDelete(personaId: string, nodeIds: string[], userId?: string): Promise<number> {
    let changed = 0;
    for (const nodeId of Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))) {
      const deleted = await this.delete(personaId, nodeId, userId);
      if (deleted) changed += 1;
    }
    return changed;
  }

  async deleteByPersona(personaId: string, userId?: string): Promise<number> {
    const scopedUserId = resolveUserId(userId);
    return this.mem0Client.deleteMemoriesByFilter({ userId: scopedUserId, personaId });
  }
}
