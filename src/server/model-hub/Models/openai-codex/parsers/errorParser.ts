import type { CodexSseEvent } from '../types';
import { toNonEmptyString } from '../utils/typeGuards';

export function toCodexStreamError(event: CodexSseEvent): string | null {
  const explicit = toNonEmptyString(event.message);
  if (explicit) return explicit;
  const nested = toNonEmptyString(event.error?.message);
  if (nested) return nested;
  const code = toNonEmptyString(event.code);
  if (code) return code;
  return null;
}

export function parseCodexHttpError(raw: string, status: number): string {
  if (!raw.trim()) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw) as {
      error?: string | { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string' &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
  } catch {
    // fall through
  }
  return raw.trim();
}
