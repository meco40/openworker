import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type { Mem0Client } from '@/server/memory/mem0';
import { formatTimestamp } from '../utils/timestamp';
import { asImportance, resolveUserId } from '../validators/typeValidators';

export interface StoreMemoryOptions {
  personaId: string;
  type: MemoryType;
  content: string;
  importance: number;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export async function storeMemory(
  client: Mem0Client,
  options: StoreMemoryOptions,
): Promise<MemoryNode> {
  const { personaId, type, content, importance, userId, metadata } = options;
  const scopedUserId = resolveUserId(userId);
  const extraMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const nowIso = new Date().toISOString();

  const result = await client.addMemory({
    userId: scopedUserId,
    personaId,
    content,
    metadata: {
      ...extraMetadata,
      type,
      importance: asImportance(importance, 3),
      confidence: 0.3,
      version: 1,
      lastVerified: nowIso,
    },
  });
  if (!result.id) {
    throw new Error('Mem0 store failed: response did not include memory id.');
  }

  return {
    id: result.id,
    type,
    content,
    embedding: [],
    importance: asImportance(importance, 3),
    confidence: 0.3,
    timestamp: formatTimestamp(),
    metadata: {
      ...extraMetadata,
      mem0Id: result.id,
      source: 'mem0',
      memoryProvider: 'mem0',
      version: 1,
      lastVerified: nowIso,
    },
  };
}
