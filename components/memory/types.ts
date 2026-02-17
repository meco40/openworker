import type { MemoryNode, MemoryType } from '../../core/memory/types';

export const MEMORY_TYPES: MemoryType[] = [
  'fact',
  'preference',
  'avoidance',
  'lesson',
  'personality_trait',
  'workflow_pattern',
];

export const TYPE_LABEL: Record<MemoryType, string> = {
  fact: 'Fakt',
  preference: 'Präferenz',
  avoidance: 'Vermeidung',
  lesson: 'Lektion',
  personality_trait: 'Eigenschaft',
  workflow_pattern: 'Workflow',
};

export interface EditDraft {
  content: string;
  type: MemoryType;
  importance: number;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MemoryHistoryEntry {
  index: number;
  action: string;
  timestamp: string;
  content?: string;
  type?: MemoryType;
  importance?: number;
  version?: number;
}

export interface MemoryHistoryResponse {
  ok?: boolean;
  node?: MemoryNode;
  history?: MemoryHistoryEntry[];
  error?: string;
}

export interface MemoryApiResponse {
  ok?: boolean;
  nodes?: MemoryNode[];
  pagination?: PaginationState;
  error?: string;
}

export interface UpdateMemoryPayload {
  ok?: boolean;
  error?: string;
}
