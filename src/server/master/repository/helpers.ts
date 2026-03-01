export type SqlPatch = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(value: unknown): boolean {
  return Boolean(value);
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}
