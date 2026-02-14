import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import type { Mem0Client, Mem0MemoryRecord, Mem0SearchHit } from './mem0Client';
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
      mem0Id: record.id,
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

function matchesQuery(node: MemoryNode, query?: string): boolean {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return node.content.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle);
}

function matchesType(node: MemoryNode, type?: MemoryType): boolean {
  if (!type) return true;
  return node.type === type;
}

export class MemoryService {
  constructor(private readonly mem0Client: Mem0Client) {}

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
    const hits = await this.mem0Client.searchMemories({
      userId: scopedUserId,
      personaId,
      query,
      limit,
    });

    const matches = hits
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
      .slice(0, Math.max(1, limit));

    const context = matches.map((result) => `[Type: ${result.node.type}] ${result.node.content}`).join('\n');

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

    const total = Math.max(filteredNodes.length, listed.total);

    return {
      nodes: filteredNodes,
      pagination: {
        page: listed.page,
        pageSize: listed.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / listed.pageSize)),
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

    await this.mem0Client.updateMemory(nodeId, {
      userId: scopedUserId,
      personaId,
      content: nextContent,
      metadata: {
        ...(currentNode.metadata || {}),
        type: nextType,
        importance: asImportance(nextImportance, currentNode.importance),
        confidence: nextConfidence,
        lastVerified: new Date().toISOString(),
        mem0Id: nodeId,
        source: 'mem0',
        memoryProvider: 'mem0',
      },
    });

    return {
      ...currentNode,
      id: nodeId,
      type: nextType,
      content: nextContent,
      importance: asImportance(nextImportance, currentNode.importance),
      timestamp: formatTimestamp(),
      metadata: {
        ...(currentNode.metadata || {}),
        lastVerified: new Date().toISOString(),
        mem0Id: nodeId,
        source: 'mem0',
        memoryProvider: 'mem0',
      },
    };
  }

  async delete(personaId: string, nodeId: string, userId?: string): Promise<boolean> {
    const _scopedUserId = resolveUserId(userId);
    const _personaId = personaId;
    try {
      await this.mem0Client.deleteMemory(nodeId);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
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
