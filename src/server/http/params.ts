export function parseBoundedIntOrNull(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function parseBoundedIntOrFallback(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return parseBoundedIntOrNull(raw, fallback, min, max) ?? fallback;
}

export function parsePositiveIntOrFallback(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
