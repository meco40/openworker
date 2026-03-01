export function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const direct = parseJsonObject(trimmed);
  if (direct) return direct;

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return parseJsonObject(trimmed.slice(first, last + 1));
}
