export function normalizeRuleText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeRuleText(value: string): string[] {
  return normalizeRuleText(value)
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

export function parseEventSeqs(sourceSeqJson: string): number[] {
  try {
    const parsed = JSON.parse(sourceSeqJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Math.floor(Number(value || 0)))
      .filter((seq) => Number.isFinite(seq) && seq > 0);
  } catch {
    return [];
  }
}
