export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_GATEWAY_EXEC_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
}

export function resolveModelHubGatewayTimeoutMs(options?: { hasTools?: boolean }): number {
  const baseTimeoutMs = parseTimeoutMs(
    process.env.MODEL_HUB_GATEWAY_TIMEOUT_MS,
    DEFAULT_GATEWAY_TIMEOUT_MS,
  );
  if (!options?.hasTools) {
    return baseTimeoutMs;
  }

  const executionTimeoutMs = parseTimeoutMs(
    process.env.MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS,
    Math.max(baseTimeoutMs, DEFAULT_GATEWAY_EXEC_TIMEOUT_MS),
  );
  return Math.max(baseTimeoutMs, executionTimeoutMs);
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Combine external signal (user abort) with internal timeout signal
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (json) {
      if (typeof json.error === 'string' && json.error) return json.error;
      if (typeof json.error === 'object' && json.error) {
        const nested = json.error as Record<string, unknown>;
        if (typeof nested.message === 'string' && nested.message) {
          return nested.message;
        }
      }
      if (typeof json.message === 'string' && json.message) return json.message;
    }
  } else {
    const text = await response.text().catch(() => '');
    if (text.trim()) return text.trim();
  }
  return `${response.status} ${response.statusText}`.trim();
}

export async function fetchJsonOk(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetchWithTimeout(url, init, timeoutMs);
    if (!response.ok) {
      const reason = await parseErrorMessage(response);
      return { ok: false, message: reason };
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return { ok: true, payload: await response.json() };
    }

    return { ok: true, payload: await response.text() };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed.';
    return { ok: false, message };
  }
}
