export function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function parseIso(input: unknown): string | null {
  const text = String(input || '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function asLimit(value: number | undefined, fallback = 20): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

export function toStringArray(values: string[]): string[] {
  return values.map((value) => String(value || '').trim()).filter((value) => value.length > 0);
}

export function toSourceRefs(rows: { seq: number; quote: string }[]): { seq: number; quote: string }[] {
  return rows
    .map((row) => ({
      seq: Number(row.seq),
      quote: String(row.quote || '').trim(),
    }))
    .filter((row) => Number.isFinite(row.seq) && row.quote.length > 0);
}
