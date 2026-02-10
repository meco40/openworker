import type { MemoryNode } from '../../../core/memory/types';

export interface MemoryRepository {
  listNodes(): MemoryNode[];
  insertNode(node: MemoryNode): void;
  updateNode(node: MemoryNode): void;
}
