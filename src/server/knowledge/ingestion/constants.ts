/**
 * Maximum number of consecutive Mem0 failures before opening a circuit
 * for the remaining facts in a window.
 */
export const MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW = 2;

/**
 * Rate limit delay in milliseconds between Mem0 store calls.
 * Used to avoid connection pool exhaustion.
 */
export const MEM0_RATE_LIMIT_DELAY_MS = 100;

/**
 * Default confidence value for entity relations.
 */
export const DEFAULT_RELATION_CONFIDENCE = 0.8;

/**
 * Default confidence value for events.
 */
export const DEFAULT_EVENT_CONFIDENCE = 0.85;

/**
 * Default topic key when none is provided.
 */
export const DEFAULT_TOPIC_KEY = 'general-meeting';

/**
 * German self-reference terms used for persona identity resolution.
 */
export const GERMAN_SELF_REFERENCES = ['ich', 'mein', 'meine'];

/**
 * English self-reference terms used for persona identity resolution.
 */
export const ENGLISH_SELF_REFERENCES = ['me', 'myself'];
