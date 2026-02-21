import type { StoredMessage } from '@/server/channels/messages/repository';
import type { KnowledgeEpisode, MeetingLedgerEntry } from '@/server/knowledge/repository';
import { uniqueStrings } from '../utils/arrayUtils';

export function buildEvidence(
  messages: StoredMessage[],
  episodes: KnowledgeEpisode[],
  ledgerRows: MeetingLedgerEntry[],
): { evidenceText: string; references: string[] } {
  const refs = [
    ...ledgerRows.flatMap((row) => row.sourceRefs || []),
    ...episodes.flatMap((row) => row.sourceRefs || []),
  ]
    .map((ref) => ({
      seq: Math.floor(Number(ref.seq || 0)),
      quote: String(ref.quote || '').trim(),
    }))
    .filter((ref) => ref.seq > 0 && ref.quote.length > 0);

  const dedupedRefs = uniqueStrings(refs.map((ref) => `${ref.seq}:${ref.quote}`)).map((entry) => {
    const split = entry.indexOf(':');
    return {
      seq: Number(entry.slice(0, split)),
      quote: entry.slice(split + 1),
    };
  });

  const bySeq = new Map<number, StoredMessage>();
  for (const message of messages) {
    const seq = Math.floor(Number(message.seq || 0));
    if (!Number.isFinite(seq) || seq <= 0) continue;
    bySeq.set(seq, message);
  }

  const evidenceLines: string[] = [];
  const references: string[] = [];
  for (const ref of dedupedRefs.slice(0, 8)) {
    const message = bySeq.get(ref.seq);
    const text = message ? String(message.content || '').trim() : ref.quote;
    const line = `- [seq:${ref.seq}] ${text || ref.quote}`;
    evidenceLines.push(line);
    references.push(`seq:${ref.seq}`);
  }

  if (evidenceLines.length === 0) {
    for (const message of messages.slice(0, 4)) {
      const seq = Math.floor(Number(message.seq || 0));
      if (!Number.isFinite(seq) || seq <= 0) continue;
      evidenceLines.push(`- [seq:${seq}] ${String(message.content || '').trim()}`);
      references.push(`seq:${seq}`);
    }
  }

  return {
    evidenceText: evidenceLines.join('\n'),
    references,
  };
}
