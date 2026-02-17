export function toJsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getOrCreateObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = parent[key];
  if (isObject(current)) {
    return current;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

export function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function readNumber(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeHostFromBind(bind: string): string {
  if (bind === 'loopback') return '127.0.0.1';
  if (bind === 'all') return '0.0.0.0';
  return bind;
}

export function normalizeBindFromHost(host: string): string {
  if (host === '127.0.0.1' || host === 'localhost') return 'loopback';
  if (host === '0.0.0.0') return 'all';
  return host;
}
