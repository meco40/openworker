import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type { Mem0Client } from '@/server/memory/mem0';
import {
  checkMemoryPoisoning,
  normalizeMemoryContent,
} from '@/server/memory/security/memoryPoisoningGuard';
import { formatTimestamp } from '../utils/timestamp';
import { asImportance, resolveUserId } from '../validators/typeValidators';
import {
  publishMemoryLifecycleChange,
  type LifecycleSignal,
  type LifecycleStatus,
} from '@/server/memory/lifecycle';

export interface StoreMemoryOptions {
  personaId: string;
  workspaceId?: string;
  type: MemoryType;
  content: string;
  importance: number;
  userId?: string;
  metadata?: Record<string, unknown>;
  /** When provided, aborting this signal will cancel the underlying Mem0 HTTP request. */
  signal?: AbortSignal;
}

export async function storeMemory(
  client: Mem0Client,
  options: StoreMemoryOptions,
): Promise<MemoryNode> {
  const { personaId, workspaceId, type, content, importance, userId, metadata, signal } = options;
  const normalizedContent = normalizeMemoryContent(content);
  const poisoningCheck = checkMemoryPoisoning(normalizedContent);
  if (poisoningCheck.riskLevel === 'blocked') {
    throw new Error(poisoningCheck.reason || 'Memory content rejected by poisoning guard.');
  }
  const scopedUserId = resolveUserId(userId);
  const memoryProvider = client.provider ?? 'mem0';
  const extraMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const nowIso = new Date().toISOString();

  const result = await client.addMemory(
    {
      userId: scopedUserId,
      personaId,
      workspaceId,
      content: normalizedContent,
      metadata: {
        ...extraMetadata,
        ...(poisoningCheck.riskLevel === 'suspicious'
          ? { securityFlag: 'suspicious', securityReason: poisoningCheck.reason }
          : {}),
        type,
        importance: asImportance(importance, 3),
        confidence: 0.3,
        lifecycleStatus: extraMetadata.lifecycleStatus || 'new',
        memoryProvider,
        version: 1,
        lastVerified: nowIso,
      },
    },
    signal,
  );
  if (!result.id) {
    throw new Error('Mem0 store failed: response did not include memory id.');
  }

  const lifecycleSignal = String(extraMetadata.lifecycleSignal || '').trim();
  if (lifecycleSignal) {
    publishMemoryLifecycleChange({
      memoryId: result.id,
      userId: scopedUserId,
      personaId,
      status: String(extraMetadata.lifecycleStatus || 'new') as LifecycleStatus,
      signal: lifecycleSignal as LifecycleSignal,
      provider: memoryProvider,
    });
  }

  return {
    id: result.id,
    type,
    content: normalizedContent,
    embedding: [],
    importance: asImportance(importance, 3),
    confidence: 0.3,
    timestamp: formatTimestamp(),
    metadata: {
      ...extraMetadata,
      ...(workspaceId ? { workspaceId } : {}),
      mem0Id: result.id,
      source: memoryProvider,
      memoryProvider,
      lifecycleStatus: extraMetadata.lifecycleStatus || 'new',
      version: 1,
      lastVerified: nowIso,
    },
  };
}
