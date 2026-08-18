import { randomBytes, timingSafeEqual } from 'node:crypto';

const INTERNAL_HEADER = 'x-mc-internal-token';
const internalToken = randomBytes(32).toString('hex');

export function getInternalRequestHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const apiToken = String(process.env.MC_API_TOKEN || '').trim();
  return {
    ...headers,
    [INTERNAL_HEADER]: internalToken,
    ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
  };
}

export function hasValidInternalRequestToken(request: Request | undefined): boolean {
  const receivedToken = request?.headers.get(INTERNAL_HEADER);
  if (!receivedToken) return false;

  const received = Buffer.from(receivedToken, 'utf8');
  const expected = Buffer.from(internalToken, 'utf8');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
