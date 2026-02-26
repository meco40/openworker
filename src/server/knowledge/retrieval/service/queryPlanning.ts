import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';
import { computeEventAnswer } from '@/server/knowledge/eventAnswerComputer';
import {
  normalizeLookupText,
  detectMentionedCounterpart,
} from '@/server/knowledge/retrieval/query/intentDetector';

import { formatProjectGraph } from './formatters';
import type { KnowledgeRecallProbeInput, RetrievalKnowledgeRepository } from '@/server/knowledge/retrieval/types';

export function isRulesIntent(query: string): boolean {
  return /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i.test(
    query,
  );
}

export function shouldTriggerRecallForQuery(
  input: KnowledgeRecallProbeInput,
  knownCounterparts: string[],
): boolean {
  const normalizedQuery = normalizeLookupText(input.query);
  if (!normalizedQuery) return false;

  const hasQuestionSignal =
    /[?]/.test(input.query) ||
    /^(was|wie|wann|wo|wer|warum|wieso|which|what|when|where|who)\b/i.test(normalizedQuery);
  const directiveRecallIntent =
    /\b(nenne|sag|sage|liste|list|zeige|zeig|erzaehl|erzahl|remember|recall|tell|summarize)\b/i.test(
      normalizedQuery,
    );
  const rulesIntent = isRulesIntent(normalizedQuery);
  if (rulesIntent && (hasQuestionSignal || directiveRecallIntent)) return true;
  if (!hasQuestionSignal && !directiveRecallIntent) return false;

  const retrospectiveHint =
    /\b(gestern|vorgestern|letzte[nrsm]?|vor\s+\d+\s+(tag|tagen|woche|wochen|monat|monaten|jahr|jahren)|damals|zuvor|fruher|frueher|letztens|neulich)\b/i.test(
      normalizedQuery,
    );
  const recallVerb =
    /\b(gesagt|besprochen|diskutiert|vereinbart|ausgehandelt|gemeint|gelaufen|war|passiert|geklart|geklaert)\b/i.test(
      normalizedQuery,
    );
  if (retrospectiveHint && recallVerb) return true;

  return detectMentionedCounterpart(input.query, knownCounterparts) !== null;
}

export function resolveEntityContext(
  plan: ReturnType<typeof planKnowledgeQuery>,
  userId: string,
  personaId: string,
  knowledgeRepository: RetrievalKnowledgeRepository,
): string {
  if (
    plan.intent !== 'general_recall' ||
    !plan.topic ||
    !knowledgeRepository.resolveEntity ||
    !knowledgeRepository.getEntityWithRelations ||
    !knowledgeRepository.getRelatedEntities
  ) {
    return '';
  }

  const graphFilter = { userId, personaId };
  const topicMatch = knowledgeRepository.resolveEntity(plan.topic, graphFilter);
  if (!topicMatch || topicMatch.entity.category !== 'project') {
    return '';
  }

  const { relations } = knowledgeRepository.getEntityWithRelations(topicMatch.entity.id);
  const relatedEntities = knowledgeRepository.getRelatedEntities(topicMatch.entity.id);
  return formatProjectGraph(topicMatch.entity.canonicalName, relations, relatedEntities);
}

export function computeCountRecallAnswer(
  plan: ReturnType<typeof planKnowledgeQuery>,
  userId: string,
  personaId: string,
  knowledgeRepository: RetrievalKnowledgeRepository,
): string | null {
  if (plan.intent !== 'count_recall' || !plan.eventFilter || !knowledgeRepository.countUniqueDays) {
    return null;
  }

  return computeEventAnswer(
    plan.eventFilter,
    { userId, personaId },
    {
      countUniqueDays: knowledgeRepository.countUniqueDays.bind(knowledgeRepository),
    },
  );
}
