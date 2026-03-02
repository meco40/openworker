export function parseClampedInt(
  request: Request,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = new URL(request.url).searchParams.get(key);
  if (raw === null) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}
