import { createHash } from 'node:crypto';

export function createMemoryIdempotencyKey(
  parts: Array<string | number | null | undefined>,
): string {
  const payload = parts.map((part) => String(part ?? '').trim()).join('\u001f');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
