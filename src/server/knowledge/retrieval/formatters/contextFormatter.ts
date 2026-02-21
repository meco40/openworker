import type { MemoryRecallLike } from '../types';
import { isRulesIntentQuery } from '../query/intentDetector';
import { extractRuleFragments } from '../query/rulesExtractor';
import { uniqueStrings } from '../utils/arrayUtils';

function truncateText(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

export function buildSemanticContextForQuery(
  query: string,
  semantic: Awaited<ReturnType<MemoryRecallLike['recallDetailed']>>,
): string {
  const rulesIntent = isRulesIntentQuery(query);
  if (rulesIntent) {
    const rulePicks = uniqueStrings(
      semantic.matches.flatMap((entry) =>
        extractRuleFragments(String(entry.node.content || ''), 3),
      ),
    )
      .slice(0, 6)
      .map((value) => `[Type: fact] ${value}`);
    if (rulePicks.length > 0) return rulePicks.join('\n');

    const fallbackRules = extractRuleFragments(semantic.context || '', 4).map(
      (value) => `[Type: fact] ${value}`,
    );
    if (fallbackRules.length > 0) return fallbackRules.join('\n');
    return '';
  }

  const picks = semantic.matches
    .map((entry) => truncateText(String(entry.node.content || ''), 280))
    .filter((value) => value.length > 0)
    .slice(0, 4)
    .map((value) => `[Type: fact] ${value}`);

  if (picks.length > 0) return picks.join('\n');
  return truncateText(semantic.context || '', 280);
}

export function formatProjectGraph(
  projectName: string,
  relations: Array<{ relationType: string; targetEntityId: string }>,
  relatedEntities: Array<{ canonicalName: string; id?: string; category: string }>,
): string {
  const lines: string[] = [`Projekt: ${projectName}`];
  const entityById = new Map<string, string>();
  for (const e of relatedEntities) {
    if (e.id) entityById.set(e.id, e.canonicalName);
  }
  for (const rel of relations) {
    const name = entityById.get(rel.targetEntityId) ?? rel.targetEntityId;
    lines.push(`${rel.relationType}: ${name}`);
  }
  return lines.join('\n');
}
