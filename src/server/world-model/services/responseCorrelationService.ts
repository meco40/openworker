export type CorrelatableTargetType = 'open_loop' | 'event' | 'task' | 'intent_fire';

export interface CorrelatableTarget {
  id: string;
  targetType: CorrelatableTargetType;
  channel?: string;
  conversationId?: string;
  externalChatId?: string | null;
  askedAt?: string;
  windowMs?: number;
}

export interface InboundUserMessage {
  channel: string;
  conversationId?: string;
  externalChatId?: string | null;
  text: string;
  receivedAt: string;
}

export interface CorrelationDecision {
  match: CorrelatableTarget | null;
  candidateCount: number;
  ambiguous: boolean;
  reason: 'exact' | 'single' | 'ambiguous' | 'none';
}

/**
 * States a user reply to the right open loop / event / task / intent fire.
 *
 * Deterministic signals first (unsichtbare Zustell-Metadaten als
 * conversation+channel+Zeitfenster), und nur bei Rest-Mehrdeutigkeit wäre ein
 * Modell nötig. Die persistente Zuordnung selbst erfolgt im Aufrufer atomar mit
 * der Statusänderung.
 */
export function correlateUserResponse(
  message: InboundUserMessage,
  candidates: CorrelatableTarget[],
  defaultWindowMs = 10 * 60 * 1000,
): CorrelationDecision {
  const scored = candidates.map((candidate) => {
    let score = 0;
    if (candidate.channel && candidate.channel === message.channel) score += 2;
    if (candidate.conversationId && candidate.conversationId === message.conversationId) {
      score += 3;
    }
    if (
      candidate.externalChatId &&
      message.externalChatId &&
      candidate.externalChatId === message.externalChatId
    ) {
      score += 4;
    }
    const askedAt = candidate.askedAt ?? '';
    const windowMs = candidate.windowMs ?? defaultWindowMs;
    const deltaMs = askedAt
      ? new Date(message.receivedAt).getTime() - new Date(askedAt).getTime()
      : null;
    if (deltaMs !== null && deltaMs >= 0 && deltaMs <= windowMs) {
      score += 2;
    }
    return { candidate, score };
  });

  // A time-window hit alone is too weak to correlate (ambiguous). A candidate
  // must also match a deterministic channel/conversation signal to count.
  const MIN_DETERMINISTIC_SCORE = 3;
  const positive = scored.filter((entry) => entry.score >= MIN_DETERMINISTIC_SCORE);
  if (positive.length === 1) {
    return {
      match: positive[0]!.candidate,
      candidateCount: candidates.length,
      ambiguous: false,
      reason: positive[0]!.score >= 5 ? 'exact' : 'single',
    };
  }
  if (positive.length > 1) {
    return {
      match: null,
      candidateCount: positive.length,
      ambiguous: true,
      reason: 'ambiguous',
    };
  }
  return { match: null, candidateCount: candidates.length, ambiguous: false, reason: 'none' };
}
