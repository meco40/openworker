import type { MemoryNode, MemoryType } from '../../../core/memory/types';

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
  listNodes(personaId: string): MemoryNode[];
  listNodesPage(personaId: string, input: MemoryListPageInput): MemoryListPageResult;
  listAllNodes(): MemoryNode[];
  insertNode(personaId: string, node: MemoryNode): void;
  updateNode(personaId: string, node: MemoryNode): void;
  deleteNode(personaId: string, nodeId: string): number;
  updateMany(
    personaId: string,
    nodeIds: string[],
    updates: { type?: MemoryType; importance?: number },
  ): number;
  deleteMany(personaId: string, nodeIds: string[]): number;
  deleteByPersona(personaId: string): number;
}
