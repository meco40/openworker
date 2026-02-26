/**
 * Input sanitization for Mem0 client
 * 
 * This module provides utilities for sanitizing and validating inputs
to the Mem0 client, ensuring safe and valid data is sent to the API.
 */

import type { Mem0MemoryInput, Mem0SearchInput, Mem0ListInput, Mem0ClientConfig } from './types';

/**
 * Maximum allowed content length
 */
export const MAX_CONTENT_LENGTH = 10000;

/**
 * Maximum allowed metadata size (in characters when JSON stringified)
 */
export const MAX_METADATA_SIZE = 10000;

function stripDisallowedControlChars(content: string): string {
  let sanitized = '';
  for (const char of content) {
    const code = char.charCodeAt(0);
    if (char === '\n' || char === '\r' || char === '\t') {
      sanitized += char;
      continue;
    }
    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }
    sanitized += char;
  }
  return sanitized;
}

/**
 * Sanitize string content
 *
 * - Trims whitespace
 * - Removes control characters
 * - Limits length
 */
export function sanitizeString(content: string, maxLength: number = MAX_CONTENT_LENGTH): string {
  let sanitized = stripDisallowedControlChars(content.trim());

  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized;
}

/**
 * Sanitize metadata object
 *
 * - Removes undefined values
 * - Limits total size
 * - Sanitizes string values
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown>,
  maxSize: number = MAX_METADATA_SIZE,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    // Skip undefined and function values
    if (value === undefined || typeof value === 'function') {
      continue;
    }

    // Sanitize string values
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value, 1000);
    } else {
      sanitized[key] = value;
    }
  }

  // Check total size
  const jsonSize = JSON.stringify(sanitized).length;
  if (jsonSize > maxSize) {
    throw new Error(`Metadata size (${jsonSize}) exceeds maximum allowed (${maxSize})`);
  }

  return sanitized;
}

/**
 * Validate and sanitize memory input
 */
export function sanitizeMemoryInput(input: Mem0MemoryInput): Mem0MemoryInput {
  return {
    userId: sanitizeString(input.userId, 100),
    personaId: sanitizeString(input.personaId, 100),
    content: sanitizeString(input.content, MAX_CONTENT_LENGTH),
    metadata: sanitizeMetadata(input.metadata),
  };
}

/**
 * Validate and sanitize search input
 */
export function sanitizeSearchInput(input: Mem0SearchInput): Mem0SearchInput {
  return {
    userId: sanitizeString(input.userId, 100),
    personaId: sanitizeString(input.personaId, 100),
    query: sanitizeString(input.query, 1000),
    limit: Math.max(1, Math.min(100, input.limit)),
    filters: input.filters ? sanitizeMetadata(input.filters, 5000) : undefined,
  };
}

/**
 * Validate and sanitize list input
 */
export function sanitizeListInput(input: Mem0ListInput): Mem0ListInput {
  return {
    userId: sanitizeString(input.userId, 100),
    personaId: input.personaId ? sanitizeString(input.personaId, 100) : undefined,
    page: Math.max(1, input.page),
    pageSize: Math.max(1, Math.min(100, input.pageSize)),
    query: input.query ? sanitizeString(input.query, 1000) : undefined,
    type: input.type ? sanitizeString(input.type, 100) : undefined,
  };
}

/**
 * Validate client configuration
 */
export function validateConfig(config: Mem0ClientConfig): void {
  if (!config.baseUrl || !config.baseUrl.trim()) {
    throw new Error('Mem0 baseUrl is required.');
  }

  // Validate URL format
  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error(`Invalid baseUrl: ${config.baseUrl}`);
  }
}
