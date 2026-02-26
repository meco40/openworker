'use client';

/**
 * Artifact utilities for swarm content management.
 * Pure functions for clamping, trimming, and normalizing artifact data.
 */

const MAX_ARTIFACT_CHARS = 20_000;
const MAX_ARTIFACT_HISTORY_JSON_CHARS = 28_000;

export function clampArtifactForPersistence(value: string, maxChars = MAX_ARTIFACT_CHARS): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}

export function trimArtifactHistoryForPayload(
  history: string[],
  maxJsonChars = MAX_ARTIFACT_HISTORY_JSON_CHARS,
): string[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const next = history.filter((entry) => String(entry || '').trim().length > 0);
  while (next.length > 0 && JSON.stringify(next).length > maxJsonChars) {
    next.shift();
  }
  return next;
}
