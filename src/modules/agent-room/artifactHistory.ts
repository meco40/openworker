const DEFAULT_HISTORY_LIMIT = 24;

export function pushArtifactSnapshot(
  history: string[],
  nextArtifact: string,
  limit = DEFAULT_HISTORY_LIMIT,
): string[] {
  const normalized = String(nextArtifact || '').trim();
  if (!normalized) return history;
  if (history[history.length - 1] === normalized) return history;
  const next = [...history, normalized];
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

export function restoreArtifactSnapshot(
  history: string[],
  index: number,
): { artifact: string; history: string[] } {
  if (!Array.isArray(history) || history.length === 0) {
    return { artifact: '', history: [] };
  }
  const normalizedIndex = Math.max(0, Math.min(index, history.length - 1));
  const artifact = String(history[normalizedIndex] || '');
  return { artifact, history: [...history] };
}

