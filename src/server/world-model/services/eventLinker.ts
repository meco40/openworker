import type { EventStatus } from '@/server/world-model/types';

export type EventUtteranceKind =
  | 'proposal'
  | 'plan'
  | 'change'
  | 'cancellation'
  | 'history'
  | 'outcome_confirmation'
  | 'unknown';

export interface EventCandidateHit {
  eventId: string;
  title: string;
  confidence: number;
  status: EventStatus;
}

export interface EventLinkerInput {
  eventId: string;
  title: string;
  eventType: string;
  status: EventStatus;
  speakerRole?: 'assistant' | 'user';
  // Kandidaten-Such-Signale (Scope/Zeit/Typ), vorbefuellt durch den Caller.
  scheduledFor?: string;
  endsAt?: string;
}

/**
 * Phase 4 (Ereignisverknuepfung):
 * Klassifiziert eine natuerlichsprachliche Aussage und verknüpft sie mit dem
 * richtigen Event. Trennt "Ich gehe essen" (plan) von "Ich war essen"
 * (outcome_confirmation). Nur die Bestaetigungsform darf ein Outcome
 * `completed` setzen.
 */
export function classifyEventUtterance(text: string): EventUtteranceKind {
  const t = text.trim().toLowerCase();

  // Vergangenheits-/Bestaetigungsformen
  if (/(war|bin gewesen|hab ich|war ich).*(essen|kino|dort|da)/.test(t)) {
    return 'outcome_confirmation';
  }
  // A cancellation followed by a replacement plan is a change, not a plain
  // cancellation (reference case: cinema cancelled, dinner planned).
  if (/(doch nicht|nicht mehr).*(stattdessen|sondern|dafür|ich gehe|gehe ich)/s.test(t)) {
    return 'change';
  }
  // Absagen
  if (/(doch nicht|nicht mehr|absage|stornier|ett sage ich ab|gehe ich doch nicht)/.test(t)) {
    return 'cancellation';
  }
  // Rueckblick
  if (
    /(was habe ich|was hab ich|letzte woche|gestern|rueckblick|erinnere mich an die woche)/.test(t)
  ) {
    return 'history';
  }
  // Plan
  if (/(ich gehe|gehe ich|ich plane|termin|ich habe .* vor|lass uns|erinnere mich)/.test(t)) {
    return 'plan';
  }
  // Aenderung / Ersatzplan
  if (/(statt|stattdessen|ersatz|andere plan)/.test(t)) {
    return 'change';
  }
  return 'unknown';
}

/**
 * Sucht Kandidaten über deterministische Signale. In dieser Stufe werden die
 * Kandidaten vom Caller aus der Laufzeit (Events mit Status `planned`/`proposed`,
 * passend zur Konversation) geliefert; diese Funktion waehlt die beste Übereinstimmung.
 */
export function pickEventCandidate(
  utteranceKind: EventUtteranceKind,
  candidates: EventCandidateHit[],
): EventCandidateHit | null {
  if (utteranceKind === 'outcome_confirmation' || utteranceKind === 'cancellation') {
    // Bestaetigungen/Absagen betreffen das aktivste geplante Event.
    const active = candidates.filter((c) => c.status === 'planned' || c.status === 'proposed');
    if (active.length === 1) return active[0]!;
    return null; // mehrdeutig
  }
  return candidates[0] ?? null;
}

export function outcomeForUtterance(
  kind: EventUtteranceKind,
): Exclude<EventStatus, 'unknown'> | null {
  if (kind === 'outcome_confirmation') return 'completed';
  if (kind === 'cancellation') return 'cancelled';
  return null;
}
