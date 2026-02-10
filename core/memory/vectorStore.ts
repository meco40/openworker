
import { MemoryNode, SearchResult } from './types';
import { cosineSimilarity, getEmbedding } from './embeddings';

class VectorStore {
  private nodes: MemoryNode[] = [];

  async addNode(type: MemoryNode['type'], content: string, importance: number): Promise<MemoryNode> {
    // Check for duplicates or similar entries to increase confidence instead of creating new ones
    const queryVector = await getEmbedding(content);
    const existing = this.nodes.find(n => cosineSimilarity(queryVector, n.embedding) > 0.95);

    if (existing) {
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      existing.importance = Math.max(existing.importance, importance);
      existing.metadata = { ...existing.metadata, lastVerified: new Date().toISOString() };
      return existing;
    }

    const node: MemoryNode = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      content,
      embedding: queryVector,
      importance,
      confidence: 0.3, // Startet niedrig, wächst durch Wiederholung
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      metadata: { lastVerified: new Date().toISOString() }
    };
    this.nodes.push(node);
    return node;
  }

  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    const queryVector = await getEmbedding(query);
    const results: SearchResult[] = this.nodes.map(node => ({
      node,
      similarity: cosineSimilarity(queryVector, node.embedding)
    }));

    // Wir gewichten Similarity zusätzlich mit Importance und Confidence
    return results
      .sort((a, b) => {
        const scoreA = a.similarity * (1 + a.node.confidence * 0.5);
        const scoreB = b.similarity * (1 + b.node.confidence * 0.5);
        return scoreB - scoreA;
      })
      .slice(0, limit);
  }

  getAllNodes(): MemoryNode[] {
    return [...this.nodes].sort((a, b) => b.importance - a.importance);
  }
}

export const globalVectorStore = new VectorStore();
