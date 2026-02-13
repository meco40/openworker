export type MemoryType =
  | 'fact'
  | 'preference'
  | 'avoidance'
  | 'lesson'
  | 'personality_trait'
  | 'workflow_pattern';

export interface MemoryNode {
  id: string;
  type: MemoryType;
  content: string;
  embedding: number[];
  importance: number; // 1-5
  confidence: number; // 0.1 - 1.0 (steigt bei Bestätigung)
  timestamp: string;
  metadata?: {
    context?: string;
    source?: string;
    lastVerified?: string;
  };
}

export interface SearchResult {
  node: MemoryNode;
  similarity: number;
}
