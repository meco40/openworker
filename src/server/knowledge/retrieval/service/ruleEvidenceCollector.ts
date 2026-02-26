import type { KnowledgeEntity } from '@/server/knowledge/entityGraph';
import type { KnowledgeEvent } from '@/server/knowledge/eventTypes';
import { uniqueStrings } from '@/server/knowledge/retrieval/utils/arrayUtils';

import type { RuleEvidenceEntry } from './types';
import { parseEventSeqs } from './query/parser';
import { hasMeaningfulOverlap, isRuleLikeStatement, extractRuleFragments } from './query/rules';

export function collectRuleFallbackEvidence(
  entities: KnowledgeEntity[],
  events: KnowledgeEvent[],
): RuleEvidenceEntry[] {
  const eventEntries: RuleEvidenceEntry[] = [];
  for (const event of events) {
    const summary = String(event.sourceSummary || '').trim();
    if (!summary) continue;
    const seqs = parseEventSeqs(event.sourceSeqJson);
    if (seqs.length === 0) continue;
    const refs = seqs.map((seq) => ({ seq, quote: summary }));
    const fragments = uniqueStrings([
      ...(isRuleLikeStatement(summary) ? [summary] : []),
      ...extractRuleFragments(summary),
    ]);
    for (const fragment of fragments) {
      if (!isRuleLikeStatement(fragment)) continue;
      eventEntries.push({ text: fragment, refs });
    }
  }

  const entityEntries: RuleEvidenceEntry[] = [];
  for (const entity of entities) {
    for (const [propertyKey, propertyValue] of Object.entries(entity.properties || {})) {
      const rawValue = String(propertyValue || '').trim();
      if (!rawValue) continue;
      const rawCandidate = `${propertyKey}: ${rawValue}`.trim();
      const fragments = uniqueStrings([
        ...(isRuleLikeStatement(rawCandidate) ? [rawCandidate] : []),
        ...extractRuleFragments(rawCandidate),
      ]);

      for (const fragment of fragments) {
        if (!isRuleLikeStatement(fragment)) continue;
        const matchedRefs = eventEntries
          .filter((eventEntry) => hasMeaningfulOverlap(eventEntry.text, fragment))
          .flatMap((eventEntry) => eventEntry.refs);
        if (matchedRefs.length === 0) continue;
        entityEntries.push({ text: fragment, refs: matchedRefs });
      }
    }
  }

  const merged = [...eventEntries, ...entityEntries];
  const dedup = new Map<string, RuleEvidenceEntry>();
  for (const entry of merged) {
    const key = entry.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const current = dedup.get(key);
    if (!current) {
      dedup.set(key, entry);
      continue;
    }
    const mergedRefs = uniqueStrings([
      ...current.refs.map((ref) => `${ref.seq}:${ref.quote}`),
      ...entry.refs.map((ref) => `${ref.seq}:${ref.quote}`),
    ]).map((value) => {
      const split = value.indexOf(':');
      return {
        seq: Number(value.slice(0, split)),
        quote: value.slice(split + 1),
      };
    });
    dedup.set(key, {
      text: current.text,
      refs: mergedRefs,
    });
  }

  return [...dedup.values()].filter((entry) => entry.refs.length > 0);
}
