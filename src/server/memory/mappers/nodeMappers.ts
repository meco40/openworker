import type { MemoryNode, MemoryType } from '@/core/memory/types';
import type { Mem0HistoryEntry, Mem0MemoryRecord, Mem0SearchHit } from '@/server/memory/mem0Client';
import { formatTimestamp } from '../utils/timestamp';
import { asMemoryType, asImportance, asConfidence, asVersion } from '../validators/typeValidators';
import type { MemoryHistoryRecord } from '../types';

export function toMemoryNode(record: Mem0MemoryRecord): MemoryNode {
  const metadata = record.metadata || {};
  return {
    id: record.id,
    type: asMemoryType(metadata.type),
    content: record.content,
    embedding: [],
    importance: asImportance(metadata.importance, 3),
    confidence: asConfidence(metadata.confidence, 0.5),
    timestamp: formatTimestamp(record.updatedAt || record.createdAt),
    metadata: {
      ...metadata,
      mem0Id: (typeof metadata.mem0Id === 'string' && metadata.mem0Id.trim()) || record.id,
      source: 'mem0',
      memoryProvider: 'mem0',
      lastVerified:
        (typeof metadata.lastVerified === 'string' && metadata.lastVerified) ||
        record.updatedAt ||
        record.createdAt ||
        new Date().toISOString(),
    },
  };
}

export function toMemoryNodeFromHit(hit: Mem0SearchHit): MemoryNode {
  return toMemoryNode({
    id: hit.id,
    content: hit.content,
    score: hit.score,
    metadata: hit.metadata,
  });
}

function asOptionalMemoryType(value: unknown): MemoryType | undefined {
  const text = String(value || '').trim() as MemoryType;
  const allowed: MemoryType[] = [
    'fact',
    'preference',
    'avoidance',
    'lesson',
    'personality_trait',
    'workflow_pattern',
  ];
  return allowed.includes(text) ? text : undefined;
}

export function toHistoryRecord(entry: Mem0HistoryEntry, index: number): MemoryHistoryRecord {
  const metadata = entry.metadata || {};
  return {
    index,
    action: String(entry.action || 'unknown').toLowerCase(),
    timestamp: String(entry.timestamp || new Date().toISOString()),
    content: entry.content,
    type: asOptionalMemoryType(metadata.type),
    importance:
      metadata.importance === undefined ? undefined : asImportance(metadata.importance, 3),
    version: metadata.version === undefined ? index + 1 : asVersion(metadata.version, index + 1),
    metadata,
  };
}
