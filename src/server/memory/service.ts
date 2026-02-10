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

  async store(type: MemoryType, content: string, importance: number): Promise<MemoryNode> {
    const queryVector = await this.getEmbedding(content);
    const existing = this.repository
      .listNodes()
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
      this.repository.updateNode(updated);
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
    this.repository.insertNode(node);
    return node;
  }

  async recall(query: string, limit = 3): Promise<string> {
    const queryVector = await this.getEmbedding(query);
    const results = this.repository
      .listNodes()
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

  snapshot(): MemoryNode[] {
    return this.repository.listNodes();
  }
}
