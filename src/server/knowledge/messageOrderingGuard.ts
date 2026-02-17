/**
 * Message Ordering Guard — idempotency keys, late-arrival detection, and reordering.
 * Prevents cross-channel duplicates and ensures chronological message processing.
 */

export interface IncomingMessage {
  channelId: string;
  originalMessageId: string;
  content: string;
  originalTimestamp: string; // ISO — when the message was originally sent
  receivedAt: string; // ISO — when the system received it
  channelSource: string; // 'web' | 'whatsapp' | 'telegram'
}

export interface StoredMessage {
  id: string;
  content: string;
  originalTimestamp: string;
  createdAt: string;
}

const DEFAULT_LATE_ARRIVAL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates a deterministic idempotency key from message properties.
 * Uses channelId + originalMessageId + first 50 chars of content.
 */
export function createIdempotencyKey(message: IncomingMessage): string {
  const contentPrefix = message.content.slice(0, 50).trim().toLowerCase();
  const raw = `${message.channelId}|${message.originalMessageId}|${contentPrefix}`;
  // Simple hash — deterministic string-based key
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32-bit integer
  }
  return `idk-${Math.abs(hash).toString(36)}`;
}

/**
 * Checks if a message arrived significantly later than its original timestamp.
 * This indicates a delayed delivery (e.g. WhatsApp bridge lag).
 */
export function isLateArrival(
  message: IncomingMessage,
  thresholdMs: number = DEFAULT_LATE_ARRIVAL_THRESHOLD_MS,
): boolean {
  const originalTime = new Date(message.originalTimestamp).getTime();
  const receivedTime = new Date(message.receivedAt).getTime();
  const delayMs = receivedTime - originalTime;
  return delayMs > thresholdMs;
}

/**
 * Reorders messages by their original timestamp (ascending).
 * Returns a new array — does not mutate the input.
 */
export function reorderByTimestamp(messages: StoredMessage[]): StoredMessage[] {
  if (messages.length <= 1) return [...messages];
  return [...messages].sort(
    (a, b) => new Date(a.originalTimestamp).getTime() - new Date(b.originalTimestamp).getTime(),
  );
}
