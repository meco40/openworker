/**
 * Maximum number of consecutive Mem0 failures before opening a circuit
 * for the remaining facts in a window.
 */
export const MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW = 2;

/**
 * Maximum cumulative Mem0 store failures across all windows in a single
 * runOnce() cycle before aborting the remaining windows.
 */
export const MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE = 5;

/**
 * Rate limit delay in milliseconds between Mem0 store calls.
 * Used to avoid connection pool exhaustion.
 */
export const MEM0_RATE_LIMIT_DELAY_MS = 250;

/**
 * Base backoff delay in milliseconds after a Mem0 store failure.
 * Doubles with each consecutive failure (exponential backoff).
 */
export const MEM0_FAILURE_BACKOFF_BASE_MS = 2000;

/**
 * Per-fact timeout for a single Mem0 store call in the knowledge ingestion
 * pipeline. Facts are stored sequentially, so this bounds each individual
 * request and prevents a stalled call from blocking the complete window.
 */
export const MEM0_STORE_FACT_TIMEOUT_MS = 15000;

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
