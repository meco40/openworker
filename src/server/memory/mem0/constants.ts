/**
 * Constants for Mem0 client
 */

/** Default timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 5000;

/** HTTP status codes considered transient (will be retried) */
export const TRANSIENT_HTTP_CODES = new Set([429, 500, 502, 503]);

/** Default maximum number of retries */
export const DEFAULT_MAX_RETRIES = 0;

/** Default base delay between retries in milliseconds */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** Marker for unconfigured mem0 runtime error */
export const MEM0_RUNTIME_UNCONFIGURED_MARKER = 'mem0 runtime is not configured';

/** Cooldown period between model hub sync attempts in milliseconds */
export const MEM0_MODEL_HUB_SYNC_COOLDOWN_MS = 5000;
