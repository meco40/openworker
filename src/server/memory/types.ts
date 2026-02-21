import type { MemoryNode, MemoryType } from '@/core/memory/types';

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

export type MemorySubject = 'user' | 'assistant' | 'conversation' | null;
