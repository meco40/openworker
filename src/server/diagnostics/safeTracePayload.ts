import { createHash } from 'node:crypto';

const IDENTIFIER_KEY = /(?:conversation|externalChat|memoryUser|persona|user|session|node)Id$/i;
const SENSITIVE_TEXT_KEY = /^(?:queryPreview|ftsQuery|error)$/i;

function stableDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function redactValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (IDENTIFIER_KEY.test(key))
    return typeof value === 'string' ? stableDigest(value) : '[redacted]';
  if (SENSITIVE_TEXT_KEY.test(key)) {
    return typeof value === 'string' ? stableDigest(value) : '[redacted]';
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(key, entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

export function safeTracePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue('payload', payload) as Record<string, unknown>;
}
