import type { EvidenceSourceRef } from '@/server/knowledge/retrieval/formatters/evidenceBuilder';

export interface RuleEvidenceEntry {
  text: string;
  refs: EvidenceSourceRef[];
}
