import {
  fullTextSearchAssertions,
  type FullTextHit,
} from '@/server/world-model/retrieval/fulltext';
import {
  findStructuredEvents,
  type StructuredEventHit,
} from '@/server/world-model/retrieval/structured';
import { searchAssertions } from '@/server/world-model/retrieval/assertions';
import { searchTasks } from '@/server/world-model/retrieval/tasks';
import { searchRelations } from '@/server/world-model/retrieval/relations';
import {
  searchOpenLoops,
  type OpenLoopRetrievalHit,
} from '@/server/world-model/retrieval/openLoops';
import { vectorSearch, type VectorHit } from '@/server/world-model/retrieval/vector';
import {
  generateEmbeddingOnce,
  getConfiguredEmbeddingProvider,
} from '@/server/world-model/embeddings/provider';
import { getWorldModelConfig } from '@/server/world-model/config';
import { planQuery, type PlannedQuery } from '@/server/world-model/retrieval/queryPlanner';
import { runWithWorldModelScope } from '@/server/world-model/db';
import {
  hybridRank,
  suppressInactiveBeforeLowerSource,
  type RankCandidate,
  type RankSource,
} from '@/server/world-model/retrieval/hybridRanker';
import { graphitiGroupId } from '@/server/world-model/graphiti/client';
import { searchGraphitiFactsWithRerank } from '@/server/world-model/graphiti/retrieval';
import type { GraphitiFact } from '@/server/world-model/graphiti/client';

export type RetrievalSource = 'structured' | 'fulltext' | 'vector' | 'graphiti' | 'none';
export type { PlannedQuery };

export interface RetrievalContextResult {
  structured: StructuredEventHit[];
  fullText: FullTextHit[];
  vector: VectorHit[];
  source: RetrievalSource;
  enabled: boolean;
  /** Zusätzliche typisierte Retrieval-Ergebnisse (Phase 10). */
  assertions?: Awaited<ReturnType<typeof searchAssertions>>;
  tasks?: Awaited<ReturnType<typeof searchTasks>>;
  relations?: Awaited<ReturnType<typeof searchRelations>>;
  openLoops?: OpenLoopRetrievalHit[];
  graphiti?: GraphitiFact[];
}

function statusFilterForIntent(intent: PlannedQuery['intent']): string[] | undefined {
  switch (intent) {
    case 'what_done':
      return ['completed', 'attended'];
    case 'what_planned':
      return ['planned', 'proposed', 'in_progress'];
    case 'what_cancelled':
      return ['cancelled', 'no_show'];
    case 'what_open':
      return ['planned', 'proposed', 'in_progress'];
    default:
      return undefined;
  }
}

/**
 * Phase 3/10 (Retrieval-Reihenfolge): strukturierte Wahrheit hat Vorrang vor
 * semantischer Aehnlichkeit. Reihenfolge:
 *   1. strukturierte Zustandsabfragen mit Query-Plan (Zeit + Intent),
 *   2. PostgreSQL-Volltext,
 *   3. pgvector (spaeter; Embedding-Befuellung steht noch aus).
 * Fail-closed: ohne aktiviertes Weltmodell liefert es leere Ergebnisse.
 */
interface RetrieveContextInput {
  userId: string;
  personaId: string;
  workspaceId?: string;
  query: string;
  limit?: number;
  asOfKnownTime?: string;
  asOfValidTime?: string;
}

export function retrieveContext(input: RetrieveContextInput): Promise<RetrievalContextResult> {
  return runWithWorldModelScope(
    {
      userId: input.userId,
      personaId: input.personaId,
      workspaceId: input.workspaceId ?? '',
    },
    () => retrieveContextInScope(input),
  );
}

async function retrieveContextInScope(
  input: RetrieveContextInput,
): Promise<RetrievalContextResult> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { structured: [], fullText: [], vector: [], source: 'none', enabled: false };
  }

  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 5)));
  const workspaceId = input.workspaceId ?? '';
  const plan = planQuery({ text: input.query });

  // All lanes are independent and are aggregated below. Start them together so
  // canonical recall latency is bounded by the slowest source, not their sum.
  const structuredPromise = findStructuredEvents({
    userId: input.userId,
    personaId: input.personaId,
    workspaceId,
    term: plan.entity || input.query,
    limit,
    timeWindow: plan.timeWindow,
    statusFilter: statusFilterForIntent(plan.intent) as
      import('@/server/world-model/types').EventStatus[] | undefined,
    validAsOf: input.asOfValidTime ?? plan.asOfValidTime,
    knownAsOf: input.asOfKnownTime ?? plan.asOfKnownTime,
  }).catch((error) => {
    console.error('[world-model:retrieval] structured event search failed:', error);
    return [] as StructuredEventHit[];
  });
  const fullTextPromise = fullTextSearchAssertions(
    input.userId,
    input.personaId,
    workspaceId,
    input.query,
    limit,
    { knownAsOf: input.asOfKnownTime ?? plan.asOfKnownTime },
  ).catch((error) => {
    console.error('[world-model:retrieval] full-text search failed:', error);
    return [] as FullTextHit[];
  });
  const domainPromise: Promise<
    [
      Awaited<ReturnType<typeof searchAssertions>>,
      Awaited<ReturnType<typeof searchTasks>>,
      Awaited<ReturnType<typeof searchRelations>>,
      OpenLoopRetrievalHit[],
    ]
  > = Promise.all([
    searchAssertions({
      userId: input.userId,
      personaId: input.personaId,
      workspaceId,
      query: plan.entity || input.query,
      knownAsOf: input.asOfKnownTime ?? plan.asOfKnownTime,
      validAsOf: input.asOfValidTime ?? plan.asOfValidTime,
      limit,
    }),
    searchTasks({
      userId: input.userId,
      personaId: input.personaId,
      workspaceId,
      query: plan.entity || input.query,
      knownAsOf: input.asOfKnownTime ?? plan.asOfKnownTime,
      limit,
    }),
    searchRelations({
      userId: input.userId,
      personaId: input.personaId,
      workspaceId,
      entityName: plan.entity || input.query,
      validAsOf: plan.asOfValidTime,
      knownAsOf: input.asOfKnownTime ?? plan.asOfKnownTime,
      limit,
    }),
    searchOpenLoops({
      userId: input.userId,
      personaId: input.personaId,
      workspaceId,
      query: plan.entity || input.query,
      limit,
    }),
  ]).catch((error) => {
    console.error('[world-model:retrieval] structured domain search failed:', error);
    return [[], [], [], []];
  });
  const vectorPromise = (async (): Promise<VectorHit[]> => {
    const provider = getConfiguredEmbeddingProvider();
    if (!provider) return [];
    try {
      const queryEmbedding = await generateEmbeddingOnce(provider, input.query);
      return await vectorSearch(
        queryEmbedding,
        input.userId,
        input.personaId,
        workspaceId,
        limit,
        0.5,
        { exclude: ['memory'] },
      );
    } catch (error) {
      console.warn('[world-model:retrieval] vector search unavailable:', error);
      return [];
    }
  })();
  const graphitiPromise = (async (): Promise<GraphitiFact[]> => {
    if (!config.graphitiRecallEnabled || !config.graphitiBackendEnabled) return [];
    try {
      return await searchGraphitiFactsWithRerank(
        graphitiGroupId(input.userId, input.personaId, workspaceId),
        {
          text: input.query,
          terms: [plan.entity || input.query],
        },
        { maxResults: limit },
      );
    } catch (error) {
      // Graphiti is derived and must never make canonical retrieval fail.
      console.warn('[world-model:retrieval] Graphiti recall unavailable:', error);
      return [];
    }
  })();

  const [structured, fullText, domain, vector, graphiti] = await Promise.all([
    structuredPromise,
    fullTextPromise,
    domainPromise,
    vectorPromise,
    graphitiPromise,
  ]);
  const [assertions, tasks, relations, openLoops] = domain;

  const candidates: RankCandidate[] = [
    ...structured.map((e) => ({
      id: e.id,
      source: 'structured' as RankSource,
      score: 1.0,
      active: e.status !== 'cancelled' && e.status !== 'no_show',
      queryIntent: plan.intent,
    })),
    ...fullText.map((a) => ({
      id: a.id,
      source: 'fulltext' as RankSource,
      score: 1.0,
      active: a.status === 'active',
      queryIntent: plan.intent,
    })),
    ...assertions.map((a) => ({
      id: a.id,
      source: 'fulltext' as RankSource,
      score: 1.0,
      active: a.status === 'active',
      queryIntent: plan.intent,
    })),
    ...vector.map((v) => ({
      id: v.targetId,
      source: 'vector' as RankSource,
      score: v.similarity,
      active: true,
    })),
  ];

  const ranked = hybridRank(candidates);
  const finalRanked = suppressInactiveBeforeLowerSource(ranked);

  const fallbackSource: RetrievalSource =
    structured.length > 0
      ? 'structured'
      : fullText.length > 0 ||
          assertions.length > 0 ||
          tasks.length > 0 ||
          relations.length > 0 ||
          openLoops.length > 0
        ? 'fulltext'
        : graphiti.length > 0
          ? 'graphiti'
          : vector.length > 0
            ? 'vector'
            : 'none';

  const source: RetrievalSource = finalRanked.length > 0 ? finalRanked[0].source : fallbackSource;
  return {
    structured,
    fullText,
    vector,
    source,
    enabled: true,
    assertions,
    tasks,
    relations,
    openLoops,
    graphiti,
  };
}

export function formatWorldModelContext(result: RetrievalContextResult): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, line: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };
  for (const event of result.structured) {
    const schedule = [event.scheduledFor, event.endsAt].filter(Boolean).join(' - ');
    const timeline = event.timeline
      .map((point) => `${point.toStatus}${point.reason ? ` (${point.reason})` : ''}`)
      .join(' -> ');
    add(
      `event:${event.id}`,
      `- Event: ${event.title}; status=${event.status}${schedule ? `; time=${schedule}` : ''}${timeline ? `; history=${timeline}` : ''}`,
    );
  }
  for (const hit of result.fullText) {
    add(
      `assertion:${hit.id}`,
      `- Assertion [${hit.id}]: ${hit.predicate} = ${hit.objectValue}; modality=${hit.modality}; status=${hit.status}; confidence=${hit.confidence}${hit.sourceObservationId ? `; source=${hit.sourceObservationId}` : ''}`,
    );
  }
  for (const assertion of result.assertions ?? []) {
    add(
      `assertion:${assertion.id}`,
      `- Assertion [${assertion.id}]: ${assertion.subjectName} ${assertion.predicate} = ${assertion.objectValue}; modality=${assertion.modality}; status=${assertion.status}; confidence=${assertion.confidence}${assertion.sourceObservationId ? `; source=${assertion.sourceObservationId}` : ''}`,
    );
  }
  for (const task of result.tasks ?? []) {
    add(
      `task:${task.id}`,
      `- Task: ${task.title}; status=${task.status}${task.dueAt ? `; due=${task.dueAt}` : ''}`,
    );
  }
  for (const relation of result.relations ?? []) {
    add(
      `relation:${relation.id}`,
      `- Relation [${relation.id}]: ${relation.sourceEntityName} ${relation.relationType} ${relation.targetEntityName}; confidence=${relation.confidence}`,
    );
  }
  for (const loop of result.openLoops ?? []) {
    add(
      `loop:${loop.id}`,
      `- Open loop [${loop.id}]: ${loop.type}; status=${loop.status}; question=${loop.question ?? ''}`,
    );
  }
  for (const hit of result.vector) {
    add(
      `vector:${hit.targetType}:${hit.targetId}`,
      `- Semantic evidence [${hit.targetId}]: ${hit.text}; similarity=${hit.similarity}`,
    );
  }
  for (const fact of result.graphiti ?? []) {
    add(`graphiti:${fact.uuid ?? fact.fact}`, `- Graphiti derived fact: ${fact.fact}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export type { FullTextHit, StructuredEventHit };
