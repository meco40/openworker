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
  embedding?: number[];
  importance: number; // 1-5
  confidence: number; // 0.1 - 1.0 (steigt bei Bestätigung)
  timestamp: string;
  metadata?: {
    [key: string]: unknown;
    context?: string;
    source?: string;
    lastVerified?: string;
    lastFeedback?: 'positive' | 'negative';
    feedbackCount?: number;
    version?: number;
    mem0Id?: string;
    memoryProvider?: 'sqlite' | 'mem0';
  };
}

export interface SearchResult {
  node: MemoryNode;
  similarity: number;
}
