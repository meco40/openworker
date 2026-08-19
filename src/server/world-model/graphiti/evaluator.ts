import { getWorldModelDb, runWithWorldModelScope } from '@/server/world-model/db';
import {
  checkGraphitiHealth,
  graphitiGroupId,
  searchGraphitiFacts,
} from '@/server/world-model/graphiti/client';

/**
 * Compares live Graphiti search results with the canonical structured rows.
 * Local shadow rows are telemetry only; they are never treated as Graphiti
 * recall evidence.
 */
export interface GraphitiEvaluationResult {
  graphitiReachable: boolean;
  shadowEdgeCount: number;
  structuredHitCount: number;
  evaluatedTargetCount: number;
  graphitiFactCount: number;
  matchedStructuredCount: number;
  precision: number;
  recall: number;
  overlapRate: number;
  recommendation: 'enable' | 'shadow' | 'fallback';
  error?: string;
}

interface EvaluationTarget {
  text: string;
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('de-DE')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

function hasMeaningfulOverlap(query: string, fact: string): boolean {
  const queryTokens = meaningfulTokens(query);
  if (queryTokens.size === 0) return false;
  const factTokens = meaningfulTokens(fact);
  let matches = 0;
  for (const token of queryTokens) {
    if (factTokens.has(token)) matches += 1;
  }
  return matches >= Math.max(1, Math.ceil(queryTokens.size * 0.4));
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
  const db = getWorldModelDb();
  const base: GraphitiEvaluationResult = {
    graphitiReachable: health.reachable,
    shadowEdgeCount: 0,
    structuredHitCount: 0,
    evaluatedTargetCount: 0,
    graphitiFactCount: 0,
    matchedStructuredCount: 0,
    precision: 0,
    recall: 0,
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
      `SELECT text FROM (
         SELECT CONCAT(s.canonical_name, ' ', a.predicate, ' ', COALESCE(a.object_value, o.canonical_name)) AS text
         FROM world_model_assertions a
         JOIN world_model_entities s ON s.id = a.subject_id
         LEFT JOIN world_model_entities o ON o.id = a.object_id
         WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3
           AND a.status = 'active' AND a.known_to IS NULL
         UNION ALL
         SELECT CONCAT(e.title, ' ', COALESCE(e.event_type, '')) AS text
         FROM world_model_events e
         WHERE e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3
           AND e.status NOT IN ('completed', 'cancelled', 'no_show')
         UNION ALL
         SELECT title AS text
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
    for (const target of targets.rows) {
      const facts = await searchGraphitiFacts(groupId, target.text, 5);
      base.graphitiFactCount += facts.length;
      const matching = facts.filter((fact) => hasMeaningfulOverlap(target.text, fact.fact));
      if (matching.length > 0) matchedFacts += 1;
    }
    base.matchedStructuredCount = matchedFacts;
    base.recall = matchedFacts / targets.rows.length;
    base.precision = base.graphitiFactCount > 0 ? matchedFacts / base.graphitiFactCount : 0;
    base.overlapRate = base.recall;
    if (base.recall >= 0.9 && base.precision >= 0.9) base.recommendation = 'enable';
  } catch (error) {
    base.graphitiReachable = false;
    base.recommendation = 'fallback';
    base.error = error instanceof Error ? error.message : String(error);
  }

  return base;
}
