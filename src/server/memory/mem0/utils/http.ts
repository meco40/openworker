/**
 * HTTP utility functions for Mem0 client
 */

import { TRANSIENT_HTTP_CODES, MEM0_RUNTIME_UNCONFIGURED_MARKER } from '../constants';

/**
 * Normalize base URL by removing trailing slashes
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Normalize API path by adding leading slash and removing trailing slashes
 */
export function normalizeApiPath(path: string): string {
  if (!path.trim()) return '';
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  return withLeading.replace(/\/+$/, '');
}

/**
 * Join URL parts
 */
export function joinUrl(baseUrl: string, apiPath: string, resourcePath: string): string {
  const suffix = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizeApiPath(apiPath)}${suffix}`;
}

/**
 * Normalize text for comparison
 */
export function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Check if error is a transient HTTP error
 */
export function isTransientHttpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /HTTP\s*(\d{3})/i.exec(message);
  if (!statusMatch) return false;
  return TRANSIENT_HTTP_CODES.has(Number(statusMatch[1]));
}

/**
 * Check if error is a timeout error
 */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /mem0 request timeout/i.test(message);
}

/**
 * Check if error is v2 unavailable error (404 or 405)
 */
export function isV2UnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(404|405)/i.test(message);
}

/**
 * Check if error is legacy delete filter error (400, 404, or 405)
 */
export function isLegacyDeleteFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(400|404|405)/i.test(message);
}

/**
 * Check if error is mem0 runtime unconfigured error
 */
export function isMem0RuntimeUnconfiguredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /HTTP\s*503/i.test(message) && message.toLowerCase().includes(MEM0_RUNTIME_UNCONFIGURED_MARKER)
  );
}

/**
 * Check if error indicates an invalid upstream model configuration (e.g. deprecated/missing model).
 * These errors should trigger Mem0 model-hub re-sync attempts.
 */
export function isMem0InvalidModelConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const hasHttpStatus = /HTTP\s*(400|404|422|500|503)/i.test(message);
  const hasModelNotFoundSignal =
    normalized.includes('is not found for api version') ||
    (normalized.includes('not_found') && normalized.includes('model'));
  const hasModelMethodSignal =
    normalized.includes('embedcontent') || normalized.includes('generatecontent');
  return hasHttpStatus && hasModelNotFoundSignal && hasModelMethodSignal;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
