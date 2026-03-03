const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchPolicyOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryableStatusCodes?: ReadonlySet<number>;
  signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithPolicy(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchPolicyOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRY_COUNT));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS));
  const retryableStatusCodes = options.retryableStatusCodes ?? RETRYABLE_STATUS_CODES;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= retries) {
    attempt += 1;
    try {
      const response = await fetchWithTimeout(input, init, timeoutMs, options.signal);
      if (attempt <= retries && retryableStatusCodes.has(response.status)) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt <= retries && (isAbortError(error) || isNetworkError(error));
      if (!shouldRetry) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed after retries.');
}
