/**
 * Truncate and normalise a string, collapsing whitespace and appending "..." if over limit.
 */
export function truncateText(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

/**
 * Format an ISO date string as DD.MM.YYYY (German locale display format).
 * Returns the original string on parse failure.
 */
export function formatDateDE(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  } catch {
    return isoString;
  }
}
