/**
 * Utility functions for Mem0 client
 */

import type { Mem0MemoryRecord, Mem0HistoryEntry, Mem0SearchHit } from '../types';

/**
 * Pick a record from an unknown value
 */
export function pickRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pick a string from an unknown value
 */
export function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pick a number from an unknown value
 */
export function pickNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Extract memories array from payload
 */
export function extractMemories(payload: unknown): unknown[] {
  const root = pickRecord(payload);
  if (Array.isArray(root.memories)) return root.memories;
  if (Array.isArray(root.results)) return root.results;
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

/**
 * Convert an entry to a memory record
 */
export function toMemoryRecord(entry: unknown): Mem0MemoryRecord | null {
  const record = pickRecord(entry);
  const nestedMemory = pickRecord(record.memory);
  const id =
    pickString(record.id) || pickString(record.memory_id) || pickString(nestedMemory.id) || '';
  const content =
    pickString(record.memory) ||
    pickString(record.text) ||
    pickString(record.content) ||
    pickString(nestedMemory.text) ||
    pickString(nestedMemory.content) ||
    '';
  if (!id || !content) return null;

  return {
    id,
    content,
    score:
      pickNumber(record.score) ??
      pickNumber(record.similarity) ??
      pickNumber(record.distance) ??
      null,
    metadata: pickRecord(record.metadata),
    createdAt: pickString(record.created_at) || pickString(record.createdAt) || undefined,
    updatedAt: pickString(record.updated_at) || pickString(record.updatedAt) || undefined,
  };
}

/**
 * Extract search hits from payload
 */
export function extractHits(payload: unknown): Mem0SearchHit[] {
  return extractMemories(payload)
    .map((entry) => toMemoryRecord(entry))
    .filter((entry): entry is Mem0MemoryRecord => entry !== null)
    .map((entry) => ({
      id: entry.id,
      content: entry.content,
      score: entry.score,
      metadata: entry.metadata,
    }));
}

/**
 * Convert an entry to a history entry
 */
export function toHistoryEntry(entry: unknown): Mem0HistoryEntry | null {
  const record = pickRecord(entry);
  if (Object.keys(record).length === 0) return null;

  const metadata = pickRecord(record.metadata);
  const nestedMemory = pickRecord(record.memory);
  const nestedOld = pickRecord(record.old_memory);
  const nestedNew = pickRecord(record.new_memory);
  const action =
    pickString(record.action) ||
    pickString(record.event) ||
    pickString(record.operation) ||
    'unknown';
  const timestamp =
    pickString(record.timestamp) ||
    pickString(record.created_at) ||
    pickString(record.updated_at) ||
    pickString(record.time) ||
    undefined;
  const content =
    pickString(record.new_memory) ||
    pickString(record.old_memory) ||
    pickString(record.content) ||
    pickString(record.text) ||
    pickString(record.memory) ||
    pickString(nestedMemory.content) ||
    pickString(nestedMemory.text) ||
    pickString(nestedNew.content) ||
    pickString(nestedNew.text) ||
    pickString(nestedOld.content) ||
    pickString(nestedOld.text) ||
    undefined;

  return {
    action,
    timestamp,
    content,
    metadata,
    raw: record,
  };
}

/**
 * Extract history entries from payload
 */
export function extractHistory(payload: unknown): Mem0HistoryEntry[] {
  const root = pickRecord(payload);
  const rows: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(root.history)
      ? root.history
      : Array.isArray(root.results)
        ? root.results
        : Array.isArray(root.data)
          ? root.data
          : [];

  return rows
    .map((entry) => toHistoryEntry(entry))
    .filter((entry): entry is Mem0HistoryEntry => entry !== null);
}

/**
 * Extract ID from payload
 */
export function extractId(payload: unknown): string | null {
  if (Array.isArray(payload) && payload.length > 0) {
    const first = toMemoryRecord(payload[0]);
    if (first) return first.id;
  }

  const root = pickRecord(payload);
  if (Array.isArray(root.results) && root.results.length > 0) {
    const firstResult = toMemoryRecord(root.results[0]);
    if (firstResult) return firstResult.id;
  }

  return (
    pickString(root.id) ||
    pickString(root.memory_id) ||
    pickString(pickRecord(root.memory).id) ||
    pickString(pickRecord(root.data).id)
  );
}

/**
 * Extract list metadata from payload
 */
export function extractListMeta(
  payload: unknown,
  fallbackPage: number,
  fallbackPageSize: number,
): {
  total: number;
  page: number;
  pageSize: number;
} {
  const root = pickRecord(payload);
  const pagination = pickRecord(root.pagination);
  const total =
    Number(root.total) ||
    Number(root.count) ||
    Number(root.total_count) ||
    Number(pagination.total) ||
    0;
  const page =
    Number(root.page) || Number(pagination.page) || Number(root.current_page) || fallbackPage;
  const pageSize =
    Number(root.page_size) ||
    Number(root.pageSize) ||
    Number(pagination.page_size) ||
    Number(pagination.pageSize) ||
    fallbackPageSize;

  return {
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : fallbackPage,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : fallbackPageSize,
  };
}

/**
 * Extract deleted count from payload
 */
export function extractDeletedCount(payload: unknown): number {
  const root = pickRecord(payload);
  const candidates = [
    Number(root.deleted),
    Number(root.count),
    Number(root.total_deleted),
    Number(root.deleted_count),
  ];

  for (const value of candidates) {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }

  if (Array.isArray(root.deleted_memories)) {
    return root.deleted_memories.length;
  }

  return 0;
}

/**
 * Extract error detail from payload
 */
export function extractErrorDetail(payload: unknown): string {
  const root = pickRecord(payload);
  const detail = pickString(root.detail);
  if (detail) return detail;

  const error = pickString(root.error);
  if (error) return error;

  const message = pickString(root.message);
  if (message) return message;

  return '';
}

// Re-export types for convenience
export type { Mem0MemoryRecord, Mem0HistoryEntry, Mem0SearchHit } from '../types';
