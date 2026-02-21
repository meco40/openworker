import type { KnowledgeEpisode, MeetingLedgerEntry } from '@/server/knowledge/repository';
import { normalizeLookupText } from '../query/intentDetector';

export function toDisplayName(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function selectConversationId(
  episodes: KnowledgeEpisode[],
  ledgerRows: MeetingLedgerEntry[],
): string | null {
  const fromLedger = String(ledgerRows[0]?.conversationId || '').trim();
  if (fromLedger) return fromLedger;
  const fromEpisodes = String(episodes[0]?.conversationId || '').trim();
  if (fromEpisodes) return fromEpisodes;
  return null;
}

export function isCounterpartMatch(value: string | null | undefined, counterpart: string): boolean {
  const left = normalizeLookupText(String(value || ''));
  const right = normalizeLookupText(counterpart);
  return Boolean(left && right && left === right);
}
