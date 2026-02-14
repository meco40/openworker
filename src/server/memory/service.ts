import crypto from 'node:crypto';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import { getServerEmbedding } from './embeddings';
import type { Mem0Client, Mem0SearchHit } from './mem0Client';
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
const MEM0_SCORE_THRESHOLD = 0.45;

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

function normalizeMem0Score(score: number | null): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0.75;
  if (score >= 0 && score <= 1) return score;
  if (score > 1 && score <= 100) return Math.min(1, score / 100);
  if (score < 0) return 0;
  return 0.75;
}

export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly getEmbedding: MemoryEmbeddingFn = getServerEmbedding,
    private readonly mem0Client?: Mem0Client,
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
      this.syncMem0Update(personaId, scopedUserId, updated);
      return updated;
    }

    const nodeId = `mem-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    let mem0Id: string | null = null;
    if (this.mem0Client) {
      const result = await this.mem0Client.addMemory({
        userId: scopedUserId,
        personaId,
        content,
        metadata: {
          type,
          importance,
          confidence: 0.3,
          localNodeId: nodeId,
        },
      });
      if (!result.id) {
        throw new Error('Mem0 store failed: response did not include memory id.');
      }
      mem0Id = result.id;
    }

    const node: MemoryNode = {
      id: nodeId,
      type,
      content,
      embedding: queryVector,
      importance,
      confidence: 0.3,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      metadata: {
        lastVerified: new Date().toISOString(),
        memoryProvider: mem0Id ? 'mem0' : 'sqlite',
        ...(mem0Id
          ? {
              mem0Id,
              source: 'mem0',
            }
          : {}),
      },
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

    if (this.mem0Client) {
      const fromMem0 = await this.recallFromMem0(personaId, query, limit, scopedUserId);
      if (fromMem0 && fromMem0.matches.length > 0) {
        return fromMem0;
      }
      return {
        context: 'No relevant memories found.',
        matches: [],
      };
    }

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
        this.syncMem0Delete(existing);
        changed += 1;
        continue;
      }

      this.repository.updateNode(personaId, updated, scopedUserId);
      this.syncMem0Update(personaId, scopedUserId, updated);
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
    const { nodes, total } = this.repository.listNodesPage(
      personaId,
      {
        page,
        pageSize,
        query: input.query?.trim() || undefined,
        type: input.type,
      },
      scopedUserId,
    );
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
    await this.syncMem0Update(personaId, scopedUserId, updated);
    return updated;
  }

  delete(personaId: string, nodeId: string, userId?: string): boolean {
    const scopedUserId = resolveUserId(userId);
    const existing = this.repository.listNodes(personaId, scopedUserId).find((node) => node.id === nodeId);
    const deleted = this.repository.deleteNode(personaId, nodeId, scopedUserId) > 0;
    if (deleted && existing) {
      this.syncMem0Delete(existing);
    }
    return deleted;
  }

  bulkUpdate(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
    userId?: string,
  ): number {
    const scopedUserId = resolveUserId(userId);
    const before = new Map(this.repository.listNodes(personaId, scopedUserId).map((node) => [node.id, node]));
    const changed = this.repository.updateMany(personaId, nodeIds, updates, scopedUserId);
    if (changed > 0) {
      for (const nodeId of nodeIds) {
        const updated = this.repository.listNodes(personaId, scopedUserId).find((node) => node.id === nodeId);
        if (!updated || !before.has(nodeId)) continue;
        this.syncMem0Update(personaId, scopedUserId, updated);
      }
    }
    return changed;
  }

  bulkDelete(personaId: string, nodeIds: string[], userId?: string): number {
    const scopedUserId = resolveUserId(userId);
    const byId = new Map(this.repository.listNodes(personaId, scopedUserId).map((node) => [node.id, node]));
    const changed = this.repository.deleteMany(personaId, nodeIds, scopedUserId);
    if (changed > 0) {
      for (const nodeId of nodeIds) {
        const existing = byId.get(nodeId);
        if (existing) this.syncMem0Delete(existing);
      }
    }
    return changed;
  }

  deleteByPersona(personaId: string, userId?: string): number {
    const scopedUserId = resolveUserId(userId);
    const nodes = this.repository.listNodes(personaId, scopedUserId);
    const changed = this.repository.deleteByPersona(personaId, scopedUserId);
    if (changed > 0) {
      for (const node of nodes) {
        this.syncMem0Delete(node);
      }
    }
    return changed;
  }

  private async recallFromMem0(
    personaId: string,
    query: string,
    limit: number,
    userId: string,
  ): Promise<MemoryRecallResult | null> {
    if (!this.mem0Client) return null;

    const hits = await this.mem0Client.searchMemories({
      userId,
      personaId,
      query,
      limit,
    });
    if (hits.length === 0) return null;

    const queryVector = await this.getEmbedding(query);
    const localNodes = this.repository.listNodes(personaId, userId);
    const byMem0Id = new Map<string, MemoryNode>();
    for (const node of localNodes) {
      const mem0Id = node.metadata?.mem0Id;
      if (!mem0Id) continue;
      byMem0Id.set(mem0Id, node);
    }

    const matches: MemoryRecallMatch[] = [];
    for (const hit of hits) {
      const mirrorNode = this.resolveOrCreateMem0MirrorNode({
        personaId,
        userId,
        hit,
        queryVector,
        byMem0Id,
      });
      const similarity = normalizeMem0Score(hit.score);
      if (similarity < MEM0_SCORE_THRESHOLD) continue;

      matches.push({
        node: mirrorNode,
        similarity,
        score: similarity * (1 + mirrorNode.confidence * 0.5) * getNodeFreshnessFactor(mirrorNode),
      });
    }

    const ranked = matches.sort((a, b) => b.score - a.score).slice(0, limit);
    if (ranked.length === 0) return null;

    return {
      context: ranked.map((result) => `[Type: ${result.node.type}] ${result.node.content}`).join('\n'),
      matches: ranked,
    };
  }

  private resolveOrCreateMem0MirrorNode(input: {
    personaId: string;
    userId: string;
    hit: Mem0SearchHit;
    queryVector: number[];
    byMem0Id: Map<string, MemoryNode>;
  }): MemoryNode {
    const existing = input.byMem0Id.get(input.hit.id);
    if (existing) {
      const refreshed: MemoryNode = {
        ...existing,
        content: input.hit.content,
        type: asMemoryType(input.hit.metadata.type ?? existing.type),
        importance: asImportance(input.hit.metadata.importance, existing.importance),
        metadata: {
          ...(existing.metadata || {}),
          mem0Id: input.hit.id,
          memoryProvider: 'mem0',
          source: 'mem0',
          lastVerified: new Date().toISOString(),
        },
      };
      this.repository.updateNode(input.personaId, refreshed, input.userId);
      input.byMem0Id.set(input.hit.id, refreshed);
      return refreshed;
    }

    const node: MemoryNode = {
      id: `mem-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      type: asMemoryType(input.hit.metadata.type),
      content: input.hit.content,
      embedding: input.queryVector,
      importance: asImportance(input.hit.metadata.importance, 3),
      confidence: 0.5,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      metadata: {
        source: 'mem0',
        mem0Id: input.hit.id,
        memoryProvider: 'mem0',
        lastVerified: new Date().toISOString(),
      },
    };
    this.repository.insertNode(input.personaId, node, input.userId);
    input.byMem0Id.set(input.hit.id, node);
    return node;
  }

  private syncMem0Update(personaId: string, userId: string, node: MemoryNode): Promise<void> {
    if (!this.mem0Client) return Promise.resolve();
    const mem0Id = node.metadata?.mem0Id;
    if (!mem0Id) return Promise.resolve();

    return this.mem0Client
      .updateMemory(mem0Id, {
        userId,
        personaId,
        content: node.content,
        metadata: {
          type: node.type,
          importance: node.importance,
          confidence: node.confidence,
          localNodeId: node.id,
        },
      })
      .catch((error) => {
        console.warn('Mem0 update sync failed:', error instanceof Error ? error.message : String(error));
      });
  }

  private syncMem0Delete(node: MemoryNode): void {
    if (!this.mem0Client) return;
    const mem0Id = node.metadata?.mem0Id;
    if (!mem0Id) return;

    void this.mem0Client.deleteMemory(mem0Id).catch((error) => {
      console.warn('Mem0 delete sync failed:', error instanceof Error ? error.message : String(error));
    });
  }
}
