import type { MemoryType } from '@/core/memory/types';
import type { Mem0Client } from '@/server/memory/mem0Client';
import { resolveUserId } from '../validators/typeValidators';

export interface BulkUpdateOptions {
  personaId: string;
  nodeIds: string[];
  updates: { type?: MemoryType; importance?: number };
  userId?: string;
}

export interface BulkDeleteOptions {
  personaId: string;
  nodeIds: string[];
  userId?: string;
}

export type UpdateFn = (
  personaId: string,
  nodeId: string,
  input: { type?: MemoryType; content?: string; importance?: number; expectedVersion?: number },
  userId?: string,
) => Promise<{ id: string } | null>;

export type DeleteFn = (personaId: string, nodeId: string, userId?: string) => Promise<boolean>;

export async function bulkUpdate(
  updateFn: UpdateFn,
  options: BulkUpdateOptions,
): Promise<number> {
  const { personaId, nodeIds, updates, userId } = options;
  let changed = 0;
  for (const nodeId of Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))) {
    const updated = await updateFn(
      personaId,
      nodeId,
      {
        type: updates.type,
        importance: updates.importance,
      },
      userId,
    );
    if (updated) changed += 1;
  }
  return changed;
}

export async function bulkDelete(
  deleteFn: DeleteFn,
  options: BulkDeleteOptions,
): Promise<number> {
  const { personaId, nodeIds, userId } = options;
  let changed = 0;
  for (const nodeId of Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))) {
    const deleted = await deleteFn(personaId, nodeId, userId);
    if (deleted) changed += 1;
  }
  return changed;
}

export async function deleteByPersona(
  client: Mem0Client,
  personaId: string,
  userId?: string,
): Promise<number> {
  const scopedUserId = resolveUserId(userId);
  return client.deleteMemoriesByFilter({ userId: scopedUserId, personaId });
}
