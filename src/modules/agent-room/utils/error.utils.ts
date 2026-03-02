/**
 * Error detection utilities for gateway and connection handling.
 */

export function isRateLimitedGatewayError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '').trim()
      : '';
  if (code === 'RATE_LIMITED') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /too many requests/i.test(message);
}

export function isTransientGatewayConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /websocket not connected|client disconnected|failed to connect/i.test(message);
}
