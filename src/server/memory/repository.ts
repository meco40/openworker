import type { MemoryNode, MemoryType } from '@/core/memory/types';

export interface MemoryListPageInput {
  page: number;
  pageSize: number;
  query?: string;
  type?: MemoryType;
}

export interface MemoryListPageResult {
  nodes: MemoryNode[];
  total: number;
}

export interface MemoryRepository {
  listNodes(personaId: string, userId?: string): MemoryNode[];
  listNodesPage(
    personaId: string,
    input: MemoryListPageInput,
    userId?: string,
  ): MemoryListPageResult;
  listAllNodes(userId?: string): MemoryNode[];
  insertNode(personaId: string, node: MemoryNode, userId?: string): void;
  updateNode(personaId: string, node: MemoryNode, userId?: string): void;
  deleteNode(personaId: string, nodeId: string, userId?: string): number;
  updateMany(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
    userId?: string,
  ): number;
  deleteMany(personaId: string, nodeIds: string[], userId?: string): number;
  deleteByPersona(personaId: string, userId?: string): number;
}
