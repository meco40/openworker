import {
  fullTextSearchAssertions,
  type FullTextHit,
} from '@/server/world-model/retrieval/fulltext';
import {
  findStructuredEvents,
  type StructuredEventHit,
} from '@/server/world-model/retrieval/structured';
import { getWorldModelConfig } from '@/server/world-model/config';

export type RetrievalSource = 'structured' | 'fulltext' | 'none';

export interface RetrievalContextResult {
  structured: StructuredEventHit[];
  fullText: FullTextHit[];
  vector: unknown[];
  source: RetrievalSource;
  enabled: boolean;
}

/**
 * Phase 3 (Retrieval-Reihenfolge): strukturierte Wahrheit hat Vorrang vor
 * semantischer Aehnlichkeit. Reihenfolge:
 *   1. strukturierte Zustandsabfragen,
 *   2. PostgreSQL-Volltext,
 *   3. pgvector (spaeter; Embedding-Befuellung steht noch aus).
 * Fail-closed: ohne aktiviertes Weltmodell liefert es leere Ergebnisse.
 */
export async function retrieveContext(input: {
  userId: string;
  personaId: string;
  workspaceId?: string;
  query: string;
  limit?: number;
}): Promise<RetrievalContextResult> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { structured: [], fullText: [], vector: [], source: 'none', enabled: false };
  }

  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)));
  const workspaceId = input.workspaceId ?? '';
  const structured = await findStructuredEvents(
    input.userId,
    input.personaId,
    workspaceId,
    input.query,
    limit,
  );
  if (structured.length > 0) {
    return { structured, fullText: [], vector: [], source: 'structured', enabled: true };
  }

  const fullText = await fullTextSearchAssertions(
    input.userId,
    input.personaId,
    workspaceId,
    input.query,
    limit,
  );
  if (fullText.length > 0) {
    return { structured: [], fullText, vector: [], source: 'fulltext', enabled: true };
  }

  // pgvector-Semantik folgt in einer spaeteren Phase (Embedding-Befuellung).
  return { structured: [], fullText: [], vector: [], source: 'none', enabled: true };
}

export function formatWorldModelContext(result: RetrievalContextResult): string | null {
  const lines: string[] = [];
  for (const event of result.structured) {
    const schedule = [event.scheduledFor, event.endsAt].filter(Boolean).join(' - ');
    const timeline = event.timeline
      .map((point) => `${point.toStatus}${point.reason ? ` (${point.reason})` : ''}`)
      .join(' -> ');
    lines.push(
      `- Event: ${event.title}; status=${event.status}${schedule ? `; time=${schedule}` : ''}${timeline ? `; history=${timeline}` : ''}`,
    );
  }
  for (const hit of result.fullText) {
    lines.push(
      `- Assertion: ${hit.predicate} = ${hit.objectValue}; modality=${hit.modality}; status=${hit.status}; confidence=${hit.confidence}`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export type { FullTextHit, StructuredEventHit };
