import type { Mem0Client, Mem0MemoryRecord } from '@/server/memory/mem0';
import type { MemoryNode } from '@/core/memory/types';
import type { MemoryFeedbackSignal } from '../types';
import {
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
  MIN_IMPORTANCE,
  MAX_IMPORTANCE,
  FORGET_NEGATIVE_FEEDBACK_THRESHOLD,
  FORGET_CONFIDENCE_THRESHOLD,
} from '../constants';
import { isNotFoundError } from '../utils/errorDetection';
import { toMemoryNode } from '../mappers/nodeMappers';
import { resolveUserId, asFeedbackCount } from '../validators/typeValidators';

export interface RegisterFeedbackOptions {
  personaId: string;
  nodeIds: string[];
  signal: MemoryFeedbackSignal;
  userId?: string;
}

async function resolveNodeVersion(
  client: Mem0Client,
  nodeId: string,
  node: MemoryNode,
): Promise<number> {
  const metaVersion = Number(node.metadata?.version);
  if (Number.isFinite(metaVersion) && metaVersion >= 1) {
    return Math.floor(metaVersion);
  }
  try {
    const history = await client.getMemoryHistory(nodeId);
    if (history.length > 0) return history.length;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  return 1;
}

export async function registerFeedback(
  client: Mem0Client,
  options: RegisterFeedbackOptions,
): Promise<number> {
  const { personaId, nodeIds, signal, userId } = options;
  const scopedUserId = resolveUserId(userId);
  const ids = Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) return 0;

  let changed = 0;
  for (const nodeId of ids) {
    let record: Mem0MemoryRecord | null = null;
    try {
      record = await client.getMemory(nodeId);
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
    if (!record) continue;

    const existingNode = toMemoryNode(record);
    const confidenceDelta = signal === 'positive' ? 0.15 : -0.2;
    const importanceDelta = signal === 'positive' ? 1 : -1;
    const nextFeedbackCount = asFeedbackCount(existingNode.metadata?.feedbackCount) + 1;
    const currentVersion = await resolveNodeVersion(client, nodeId, existingNode);
    const nextVersion = currentVersion + 1;
    const nextConfidence = Math.min(
      MAX_CONFIDENCE,
      Math.max(MIN_CONFIDENCE, existingNode.confidence + confidenceDelta),
    );
    const nextImportance = Math.min(
      MAX_IMPORTANCE,
      Math.max(MIN_IMPORTANCE, existingNode.importance + importanceDelta),
    );

    if (
      signal === 'negative' &&
      nextFeedbackCount >= FORGET_NEGATIVE_FEEDBACK_THRESHOLD &&
      nextConfidence <= FORGET_CONFIDENCE_THRESHOLD
    ) {
      await client.deleteMemory(nodeId);
      changed += 1;
      continue;
    }

    await client.updateMemory(nodeId, {
      userId: scopedUserId,
      personaId,
      content: existingNode.content,
      metadata: {
        ...(existingNode.metadata || {}),
        type: existingNode.type,
        importance: nextImportance,
        confidence: nextConfidence,
        lastVerified: new Date().toISOString(),
        lastFeedback: signal,
        feedbackCount: nextFeedbackCount,
        version: nextVersion,
        mem0Id: nodeId,
        source: 'mem0',
        memoryProvider: 'mem0',
      },
    });
    changed += 1;
  }

  return changed;
}
