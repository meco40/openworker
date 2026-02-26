/**
 * Deduplication logic for Mem0 client
 *
 * Note: This module provides utilities for detecting and handling duplicate memories.
 * Deduplication can occur at the client level or be delegated to the mem0 API.
 */

import type { Mem0MemoryRecord } from './types';

/**
 * Similarity threshold for considering memories as duplicates
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

/**
 * Deduplication options
 */
export interface DeduplicationOptions {
  threshold?: number;
  compareMetadata?: boolean;
  metadataKeys?: string[];
}

/**
 * Calculate text similarity (simple Jaccard-like similarity)
 *
 * Placeholder for more sophisticated similarity metrics.
 */
export function calculateSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Check if two memories are duplicates
 */
export function isDuplicate(
  memory1: Mem0MemoryRecord,
  memory2: Mem0MemoryRecord,
  options: DeduplicationOptions = {},
): boolean {
  const threshold = options.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;

  // Check content similarity
  const contentSimilarity = calculateSimilarity(memory1.content, memory2.content);
  if (contentSimilarity < threshold) {
    return false;
  }

  // Optionally check metadata
  if (options.compareMetadata && options.metadataKeys) {
    for (const key of options.metadataKeys) {
      if (memory1.metadata[key] !== memory2.metadata[key]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Find duplicates in a list of memories
 */
export function findDuplicates(
  memories: Mem0MemoryRecord[],
  options: DeduplicationOptions = {},
): Array<[Mem0MemoryRecord, Mem0MemoryRecord]> {
  const duplicates: Array<[Mem0MemoryRecord, Mem0MemoryRecord]> = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (isDuplicate(memories[i], memories[j], options)) {
        duplicates.push([memories[i], memories[j]]);
      }
    }
  }

  return duplicates;
}

/**
 * Merge duplicate memories
 *
 * Placeholder for merge strategy when duplicates are found.
 */
export function mergeDuplicates(
  memories: Mem0MemoryRecord[],
  _options: DeduplicationOptions = {},
): Mem0MemoryRecord[] {
  // Simple implementation: keep the first occurrence of each unique memory
  const unique: Mem0MemoryRecord[] = [];
  const seen = new Set<string>();

  for (const memory of memories) {
    if (!seen.has(memory.id)) {
      seen.add(memory.id);
      unique.push(memory);
    }
  }

  return unique;
}
