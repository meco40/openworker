import { getWorldModelDb, runWithWorldModelScope } from '@/server/world-model/db';
import { checkGraphitiHealth, graphitiGroupId } from '@/server/world-model/graphiti/client';
import {
  isRelevantRankedGraphitiFact,
  rankGraphitiFacts,
  searchGraphitiFactsWithRerank,
} from '@/server/world-model/graphiti/retrieval';

/**
 * Compares live Graphiti search results with canonical PostgreSQL rows.
 * Graphiti is measured as a derived retrieval projection; it is never used
 * as the source of truth for this quality gate.
 */
export interface GraphitiEvaluationResult {
  graphitiReachable: boolean;
  shadowEdgeCount: number;
  structuredHitCount: number;
  evaluatedTargetCount: number;
  graphitiFactCount: number;
  relevantFactCount: number;
  matchedStructuredCount: number;
  provenanceMatchCount: number;
  retrievalK: number;
  precision: number;
  recall: number;
  precisionAt1: number;
  recallAt1: number;
  precisionAt3: number;
  recallAt3: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  overlapRate: number;
  recommendation: 'enable' | 'shadow' | 'fallback';
  error?: string;
}

interface EvaluationTarget {
  targetId: string;
  targetKind: 'assertion' | 'event' | 'task';
  text: string;
  terms: string[];
  aliases: string[];
  sourceName: string | null;
  targetName: string | null;
}

function expectedNodeUuid(
  target: EvaluationTarget,
  groupId: string,
  side: 'source' | 'target',
): string | undefined {
  const name = side === 'source' ? target.sourceName : target.targetName;
  if (!name || target.targetKind !== 'assertion') return undefined;
  return `${side === 'source' ? 'ent' : 'obj'}:${name}:${groupId}`;
}

function targetQuery(target: EvaluationTarget): {
  text: string;
  terms: string[];
  aliases: string[];
} {
  return { text: target.text, terms: target.terms, aliases: target.aliases };
}

export function evaluateGraphitiValue(input: {
  userId: string;
  personaId: string;
  workspaceId: string;
}): Promise<GraphitiEvaluationResult> {
  return runWithWorldModelScope(input, () => evaluateGraphitiValueInScope(input));
}

async function evaluateGraphitiValueInScope(input: {
  userId: string;
  personaId: string;
  workspaceId: string;
}): Promise<GraphitiEvaluationResult> {
  const health = await checkGraphitiHealth();
  const retrievalK = Math.max(5, Math.min(50, Number(process.env.GRAPHITI_SEARCH_RESULTS) || 5));
  const db = getWorldModelDb();
  const base: GraphitiEvaluationResult = {
    graphitiReachable: health.reachable,
    shadowEdgeCount: 0,
    structuredHitCount: 0,
    evaluatedTargetCount: 0,
    graphitiFactCount: 0,
    relevantFactCount: 0,
    matchedStructuredCount: 0,
    provenanceMatchCount: 0,
    retrievalK,
    precision: 0,
    recall: 0,
    precisionAt1: 0,
    recallAt1: 0,
    precisionAt3: 0,
    recallAt3: 0,
    precisionAtK: 0,
    recallAtK: 0,
    mrr: 0,
    overlapRate: 0,
    recommendation: health.reachable ? 'shadow' : 'fallback',
    ...(health.error ? { error: health.error } : {}),
  };

  try {
    const shadow = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM world_model_graphiti_shadow
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3`,
      [input.userId, input.personaId, input.workspaceId],
    );
    base.shadowEdgeCount = Number(shadow.rows[0]?.count ?? 0);

    const targets = await db.query<EvaluationTarget>(
      `SELECT target_id AS "targetId", target_kind AS "targetKind", text, terms, aliases,
              source_name AS "sourceName", target_name AS "targetName"
       FROM (
         SELECT a.id::text AS target_id,
           'assertion'::text AS target_kind,
           CONCAT_WS(' ', s.canonical_name, a.predicate,
             COALESCE(a.object_value, o.canonical_name)) AS text,
           ARRAY_REMOVE(ARRAY[s.canonical_name, a.predicate, a.object_value, o.canonical_name], NULL::text) AS terms,
           ARRAY(
             SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(s.properties->'aliases') = 'array'
                 THEN s.properties->'aliases' ELSE '[]'::jsonb END
             )
           ) || ARRAY(
             SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(o.properties->'aliases') = 'array'
                 THEN o.properties->'aliases' ELSE '[]'::jsonb END
             )
           ) AS aliases,
           s.canonical_name AS source_name,
           COALESCE(a.object_value, o.canonical_name) AS target_name
         FROM world_model_assertions a
         JOIN world_model_entities s ON s.id = a.subject_id
         LEFT JOIN world_model_entities o ON o.id = a.object_id
         WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3
           AND a.status = 'active' AND a.known_to IS NULL
         UNION ALL
         SELECT e.id::text, 'event'::text,
           CONCAT_WS(' ', e.title, e.event_type),
           ARRAY_REMOVE(ARRAY[e.title, e.event_type], NULL::text),
           ARRAY[]::text[], NULL::text, NULL::text
         FROM world_model_events e
         WHERE e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3
           AND e.status NOT IN ('completed', 'cancelled', 'no_show')
         UNION ALL
         SELECT t.id::text, 'task'::text, t.title,
           ARRAY_REMOVE(ARRAY[t.title], NULL::text),
           ARRAY[]::text[], NULL::text, NULL::text
         FROM world_model_tasks t
         WHERE t.user_id = $1 AND t.persona_id = $2 AND t.workspace_id = $3
           AND t.status NOT IN ('completed', 'cancelled')
       ) targets
       WHERE text IS NOT NULL AND text <> ''
       ORDER BY text
       LIMIT 50`,
      [input.userId, input.personaId, input.workspaceId],
    );
    base.structuredHitCount = targets.rows.length;
    base.evaluatedTargetCount = targets.rows.length;
    if (!health.reachable || targets.rows.length === 0) return base;

    const groupId = graphitiGroupId(input.userId, input.personaId, input.workspaceId);
    let matchedFacts = 0;
    let relevantFacts = 0;
    let provenanceMatches = 0;
    let reciprocalRankTotal = 0;
    const topKStats = new Map([
      [1, { returned: 0, relevant: 0, matched: 0 }],
      [3, { returned: 0, relevant: 0, matched: 0 }],
      [retrievalK, { returned: 0, relevant: 0, matched: 0 }],
    ]);

    for (const target of targets.rows) {
      const facts = await searchGraphitiFactsWithRerank(groupId, targetQuery(target), {
        maxResults: retrievalK,
        expectedSourceNodeUuid: expectedNodeUuid(target, groupId, 'source'),
        expectedTargetNodeUuid: expectedNodeUuid(target, groupId, 'target'),
      });
      const ranked = rankGraphitiFacts(targetQuery(target), facts, {
        expectedSourceNodeUuid: expectedNodeUuid(target, groupId, 'source'),
        expectedTargetNodeUuid: expectedNodeUuid(target, groupId, 'target'),
      });
      base.graphitiFactCount += ranked.length;

      const matching = ranked.filter((candidate) => isRelevantRankedGraphitiFact(candidate));
      relevantFacts += matching.length;
      provenanceMatches += matching.filter((candidate) => candidate.provenanceMatch).length;
      if (matching.length > 0) {
        matchedFacts += 1;
        const firstRelevantIndex = ranked.findIndex((candidate) =>
          isRelevantRankedGraphitiFact(candidate),
        );
        if (firstRelevantIndex >= 0) reciprocalRankTotal += 1 / (firstRelevantIndex + 1);
      }
      for (const [k, stats] of topKStats) {
        const topFacts = ranked.slice(0, k);
        const topRelevant = topFacts.filter((candidate) => isRelevantRankedGraphitiFact(candidate));
        stats.returned += topFacts.length;
        stats.relevant += topRelevant.length;
        if (topRelevant.length > 0) stats.matched += 1;
      }
    }

    base.relevantFactCount = relevantFacts;
    base.matchedStructuredCount = matchedFacts;
    base.provenanceMatchCount = provenanceMatches;
    base.recallAtK = targets.rows.length > 0 ? matchedFacts / targets.rows.length : 0;
    base.precisionAtK = base.graphitiFactCount > 0 ? relevantFacts / base.graphitiFactCount : 0;
    const top1 = topKStats.get(1)!;
    const top3 = topKStats.get(3)!;
    base.recallAt1 = targets.rows.length > 0 ? top1.matched / targets.rows.length : 0;
    base.precisionAt1 = top1.returned > 0 ? top1.relevant / top1.returned : 0;
    base.recallAt3 = targets.rows.length > 0 ? top3.matched / targets.rows.length : 0;
    base.precisionAt3 = top3.returned > 0 ? top3.relevant / top3.returned : 0;
    base.mrr = targets.rows.length > 0 ? reciprocalRankTotal / targets.rows.length : 0;
    base.recall = base.recallAtK;
    base.precision = base.precisionAtK;
    base.overlapRate = base.recallAtK;
    if (base.recallAtK >= 0.9 && base.precisionAtK >= 0.9) base.recommendation = 'enable';
  } catch (error) {
    base.graphitiReachable = false;
    base.recommendation = 'fallback';
    base.error = error instanceof Error ? error.message : String(error);
  }

  return base;
}
