/**
 * Utility functions for recall service
 */

import type { StrictRecallCandidate } from './types';

/**
 * Normalize text for matching by:
 * - Converting to lowercase
 * - Removing diacritics
 * - Replacing ß with ss
 * - Normalizing whitespace
 */
export function normalizeForMatch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize normalized text into word tokens
 */
export function tokenizeNormalized(value: string): string[] {
  return (
    value
      .match(/[\p{L}\p{N}]+/gu)
      ?.map((token) => token.trim())
      .filter(Boolean) || []
  );
}

/**
 * Count how many tokens appear in the text
 */
export function countHits(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (token && text.includes(token)) hits += 1;
  }
  return hits;
}

/**
 * Check if text contains any of the given tokens
 */
export function hasAnyToken(text: string, tokens: Set<string>): boolean {
  for (const token of tokens) {
    if (text.includes(token)) return true;
  }
  return false;
}

/**
 * Apply recency boost to candidates based on timestamp
 * Newer items get higher scores
 */
export function applyRecencyBoost(candidates: StrictRecallCandidate[]): void {
  const timestamps = candidates
    .map((candidate) => (candidate.createdAt ? Date.parse(candidate.createdAt) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return;
  const newest = Math.max(...timestamps);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const candidate of candidates) {
    if (!candidate.createdAt) continue;
    const ts = Date.parse(candidate.createdAt);
    if (!Number.isFinite(ts)) continue;
    const dayDistance = Math.max(0, (newest - ts) / dayMs);
    const boost = Math.max(0, 0.7 - dayDistance * 0.1);
    candidate.score += boost;
  }
}

/**
 * Deduplicate candidates by normalized text, keeping highest score
 */
export function dedupeCandidates(candidates: StrictRecallCandidate[]): StrictRecallCandidate[] {
  const map = new Map<string, StrictRecallCandidate>();
  for (const candidate of candidates) {
    const key = candidate.normalized;
    const existing = map.get(key);
    if (!existing || candidate.score > existing.score) {
      map.set(key, candidate);
    }
  }
  return [...map.values()];
}
