/**
 * Session management constants.
 */

/**
 * Priority levels for command queue ordering.
 * Higher values are processed first.
 */
export const QUEUE_PRIORITY = {
  abort: 500,
  approval: 400,
  steer: 300,
  follow_up: 200,
  input: 100,
} as const;

/**
 * Default maximum queue length per session.
 */
export const DEFAULT_MAX_QUEUE_LENGTH = 64;

/**
 * Minimum allowed queue length.
 */
export const MIN_QUEUE_LENGTH = 4;

/**
 * Maximum allowed queue length.
 */
export const MAX_QUEUE_LENGTH = 512;
