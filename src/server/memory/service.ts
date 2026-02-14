import crypto from 'node:crypto';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import { getServerEmbedding } from './embeddings';
import type { MemoryRepository } from './repository';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

export type MemoryEmbeddingFn = (text: string) => Promise<number[]>;
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

const RECALL_SIMILARITY_THRESHOLD = 0.7;
const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 1.0;
const MIN_IMPORTANCE = 1;
const MAX_IMPORTANCE = 5;
const STALE_DECAY_LIMIT = 0.35;
const FORGET_NEGATIVE_FEEDBACK_THRESHOLD = 3;
const FORGET_CONFIDENCE_THRESHOLD = 0.15;

function resolveUserId(userId?: string): string {
  const normalized = String(userId || '').trim();
  return normalized || LEGACY_LOCAL_USER_ID;
}

function getNodeFreshnessFactor(node: MemoryNode): number {
  const reference = node.metadata?.lastVerified || node.timestamp || '';
  const time = Date.parse(reference);
  if (!Number.isFinite(time)) return 1;
  const ageMs = Math.max(0, Date.now() - time);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const penalty = Math.min(STALE_DECAY_LIMIT, (ageDays / 365) * STALE_DECAY_LIMIT);
  return 1 - penalty;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly getEmbedding: MemoryEmbeddingFn = getServerEmbedding,
  ) {}

  async store(
    personaId: string,
    type: MemoryType,
    content: string,
    importance: number,
    userId?: string,
  ): Promise<MemoryNode> {
    const scopedUserId = resolveUserId(userId);
    const queryVector = await this.getEmbedding(content);
    const existing = this.repository
      .listNodes(personaId, scopedUserId)
      .find((node) => cosineSimilarity(queryVector, node.embedding) > 0.95);

    if (existing) {
      const updated: MemoryNode = {
        ...existing,
        importance: Math.max(existing.importance, importance),
        confidence: Math.min(1.0, existing.confidence + 0.1),
        metadata: {
          ...(existing.metadata || {}),
          lastVerified: new Date().toISOString(),
        },
      };
      this.repository.updateNode(personaId, updated, scopedUserId);
      return updated;
    }

    const node: MemoryNode = {
      id: `mem-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type,
      content,
      embedding: queryVector,
      importance,
      confidence: 0.3,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      metadata: { lastVerified: new Date().toISOString() },
    };
    this.repository.insertNode(personaId, node, scopedUserId);
    return node;
  }

  async recallDetailed(
    personaId: string,
    query: string,
    limit = 3,
    userId?: string,
  ): Promise<MemoryRecallResult> {
    const scopedUserId = resolveUserId(userId);
    const queryVector = await this.getEmbedding(query);
    const ranked = this.repository
      .listNodes(personaId, scopedUserId)
      .map((node) => ({
        node,
        similarity: cosineSimilarity(queryVector, node.embedding),
        score: 0,
      }))
      .map((entry) => ({
        ...entry,
        score:
          entry.similarity *
          (1 + entry.node.confidence * 0.5) *
          getNodeFreshnessFactor(entry.node),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const matches = ranked.filter((result) => result.similarity > RECALL_SIMILARITY_THRESHOLD);
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

  registerFeedback(
    personaId: string,
    nodeIds: string[],
    signal: MemoryFeedbackSignal,
    userId?: string,
  ): number {
    const scopedUserId = resolveUserId(userId);
    const ids = Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)));
    if (ids.length === 0) return 0;

    const byId = new Map(this.repository.listNodes(personaId, scopedUserId).map((node) => [node.id, node]));
    let changed = 0;

    for (const nodeId of ids) {
      const existing = byId.get(nodeId);
      if (!existing) continue;

      const confidenceDelta = signal === 'positive' ? 0.15 : -0.2;
      const importanceDelta = signal === 'positive' ? 1 : -1;
      const nextFeedbackCount = (existing.metadata?.feedbackCount || 0) + 1;
      const updated: MemoryNode = {
        ...existing,
        confidence: Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, existing.confidence + confidenceDelta)),
        importance: Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, existing.importance + importanceDelta)),
        metadata: {
          ...(existing.metadata || {}),
          lastVerified: new Date().toISOString(),
          lastFeedback: signal,
          feedbackCount: nextFeedbackCount,
        },
      };

      if (
        signal === 'negative' &&
        nextFeedbackCount >= FORGET_NEGATIVE_FEEDBACK_THRESHOLD &&
        updated.confidence <= FORGET_CONFIDENCE_THRESHOLD
      ) {
        this.repository.deleteNode(personaId, nodeId, scopedUserId);
        changed += 1;
        continue;
      }

      this.repository.updateNode(personaId, updated, scopedUserId);
      changed += 1;
    }

    return changed;
  }

  snapshot(personaId?: string, userId?: string): MemoryNode[] {
    const scopedUserId = resolveUserId(userId);
    if (!personaId) {
      return this.repository.listAllNodes(userId ? scopedUserId : undefined);
    }
    return this.repository.listNodes(personaId, scopedUserId);
  }

  listPage(
    personaId: string,
    input: {
      page: number;
      pageSize: number;
      query?: string;
      type?: MemoryType;
    },
    userId?: string,
  ): {
    nodes: MemoryNode[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  } {
    const scopedUserId = resolveUserId(userId);
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const { nodes, total } = this.repository.listNodesPage(personaId, {
      page,
      pageSize,
      query: input.query?.trim() || undefined,
      type: input.type,
    }, scopedUserId);
    return {
      nodes,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
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
    const existing = this.repository.listNodes(personaId, scopedUserId).find((node) => node.id === nodeId);
    if (!existing) {
      return null;
    }

    const nextContent = input.content ?? existing.content;
    const nextEmbedding =
      input.content !== undefined && input.content !== existing.content
        ? await this.getEmbedding(nextContent)
        : existing.embedding;

    const updated: MemoryNode = {
      ...existing,
      type: input.type ?? existing.type,
      content: nextContent,
      embedding: nextEmbedding,
      importance: input.importance ?? existing.importance,
      metadata: {
        ...(existing.metadata || {}),
        lastVerified: new Date().toISOString(),
      },
    };

    this.repository.updateNode(personaId, updated, scopedUserId);
    return updated;
  }

  delete(personaId: string, nodeId: string, userId?: string): boolean {
    const scopedUserId = resolveUserId(userId);
    return this.repository.deleteNode(personaId, nodeId, scopedUserId) > 0;
  }

  bulkUpdate(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
    userId?: string,
  ): number {
    const scopedUserId = resolveUserId(userId);
    return this.repository.updateMany(personaId, nodeIds, updates, scopedUserId);
  }

  bulkDelete(personaId: string, nodeIds: string[], userId?: string): number {
    const scopedUserId = resolveUserId(userId);
    return this.repository.deleteMany(personaId, nodeIds, scopedUserId);
  }

  deleteByPersona(personaId: string, userId?: string): number {
    const scopedUserId = resolveUserId(userId);
    return this.repository.deleteByPersona(personaId, scopedUserId);
  }
}
