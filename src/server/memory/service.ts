import crypto from 'node:crypto';
import type { MemoryNode, MemoryType } from '../../../core/memory/types';
import { getServerEmbedding } from './embeddings';
import type { MemoryRepository } from './repository';

export type MemoryEmbeddingFn = (text: string) => Promise<number[]>;

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
  ): Promise<MemoryNode> {
    const queryVector = await this.getEmbedding(content);
    const existing = this.repository
      .listNodes(personaId)
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
      this.repository.updateNode(personaId, updated);
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
    this.repository.insertNode(personaId, node);
    return node;
  }

  async recall(personaId: string, query: string, limit = 3): Promise<string> {
    const queryVector = await this.getEmbedding(query);
    const results = this.repository
      .listNodes(personaId)
      .map((node) => ({
        node,
        similarity: cosineSimilarity(queryVector, node.embedding),
      }))
      .sort((a, b) => {
        const scoreA = a.similarity * (1 + a.node.confidence * 0.5);
        const scoreB = b.similarity * (1 + b.node.confidence * 0.5);
        return scoreB - scoreA;
      })
      .slice(0, limit);

    const context = results
      .filter((result) => result.similarity > 0.7)
      .map((result) => `[Type: ${result.node.type}] ${result.node.content}`)
      .join('\n');

    return context || 'No relevant memories found.';
  }

  snapshot(personaId?: string): MemoryNode[] {
    if (!personaId) {
      return this.repository.listAllNodes();
    }
    return this.repository.listNodes(personaId);
  }

  listPage(
    personaId: string,
    input: {
      page: number;
      pageSize: number;
      query?: string;
      type?: MemoryType;
    },
  ): {
    nodes: MemoryNode[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  } {
    const page = Math.max(1, Math.floor(input.page));
    const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize)));
    const { nodes, total } = this.repository.listNodesPage(personaId, {
      page,
      pageSize,
      query: input.query?.trim() || undefined,
      type: input.type,
    });
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
  ): Promise<MemoryNode | null> {
    const existing = this.repository.listNodes(personaId).find((node) => node.id === nodeId);
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

    this.repository.updateNode(personaId, updated);
    return updated;
  }

  delete(personaId: string, nodeId: string): boolean {
    return this.repository.deleteNode(personaId, nodeId) > 0;
  }

  bulkUpdate(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
  ): number {
    return this.repository.updateMany(personaId, nodeIds, updates);
  }

  bulkDelete(personaId: string, nodeIds: string[]): number {
    return this.repository.deleteMany(personaId, nodeIds);
  }

  deleteByPersona(personaId: string): number {
    return this.repository.deleteByPersona(personaId);
  }
}
