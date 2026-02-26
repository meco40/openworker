import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';
import type { PersonaType } from '@/server/knowledge/personaStrategies';
import type {
  KnowledgeRetrievalInput,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalServiceOptions,
} from '@/server/knowledge/retrieval/types';
import { uniqueStrings } from '@/server/knowledge/retrieval/utils/arrayUtils';
import { detectMentionedCounterpart } from '@/server/knowledge/retrieval/query/intentDetector';

import type { RuleEvidenceEntry } from './types';
import { detectBinaryRecallConflict } from './query/intent';
import { hasRuleLikeFragments, hasValidSourceRefs } from './query/rules';
import { rankEpisodesByQuery, rankLedgerByQuery } from './ranking';
import {
  buildSemanticContextForQuery,
  buildEvidence,
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
  isCounterpartMatch,
  selectConversationId,
  calculateAndApplyBudget,
} from './formatters';
import { collectRuleFallbackEvidence } from './ruleEvidenceCollector';
import { computeCountRecallAnswer, isRulesIntent, resolveEntityContext } from './queryPlanning';

export interface ExecuteKnowledgeRetrievalArgs {
  input: KnowledgeRetrievalInput;
  options: KnowledgeRetrievalServiceOptions;
  maxContextTokens: number;
}

export async function executeKnowledgeRetrieval({
  input,
  options,
  maxContextTokens,
}: ExecuteKnowledgeRetrievalArgs): Promise<KnowledgeRetrievalResult> {
  const plan = planKnowledgeQuery(input.query);
  const rulesIntent = isRulesIntent(input.query);
  const topicFilter = plan.topic && plan.topic !== 'ausgehandelt' ? plan.topic : undefined;
  const strictTopicFilterRequested = Boolean(topicFilter);

  const graphFilter = { userId: input.userId, personaId: input.personaId };
  if (plan.counterpart && options.knowledgeRepository.resolveEntity) {
    const entityMatch = options.knowledgeRepository.resolveEntity(plan.counterpart, graphFilter);
    if (entityMatch) {
      plan.resolvedEntityId = entityMatch.entity.id;
      plan.resolvedEntityName = entityMatch.entity.canonicalName;
      const aliasNames = [entityMatch.entity.canonicalName];
      if (options.knowledgeRepository.getEntityWithRelations) {
        const { aliases } = options.knowledgeRepository.getEntityWithRelations(
          entityMatch.entity.id,
        );
        for (const a of aliases) {
          aliasNames.push(a.alias);
        }
      }
      plan.counterpartAliases = aliasNames;

      if (plan.eventFilter) {
        plan.eventFilter.counterpartEntity = entityMatch.entity.canonicalName;
      }
    }
  }

  const computedAnswerText = computeCountRecallAnswer(
    plan,
    input.userId,
    input.personaId,
    options.knowledgeRepository,
  );
  const entityContextSection = resolveEntityContext(
    plan,
    input.userId,
    input.personaId,
    options.knowledgeRepository,
  );

  const filter = {
    userId: input.userId,
    personaId: input.personaId,
    counterpart: plan.counterpart || undefined,
    topicKey: topicFilter,
    from: plan.timeRange?.from,
    to: plan.timeRange?.to,
    limit: 8,
  };

  const stageStats: Record<string, number> = {
    ledger: 0,
    episodes: 0,
    semantic: 0,
    evidence: 0,
    graphRules: 0,
  };

  try {
    let ledgerRows = options.knowledgeRepository.listMeetingLedger(filter);
    let episodes = options.knowledgeRepository.listEpisodes(filter);
    let usedTopicFallback = false;

    if (strictTopicFilterRequested && ledgerRows.length === 0 && episodes.length === 0) {
      const relaxedFilter = {
        ...filter,
        topicKey: undefined,
      };
      ledgerRows = options.knowledgeRepository.listMeetingLedger(relaxedFilter);
      episodes = options.knowledgeRepository.listEpisodes(relaxedFilter);
      usedTopicFallback = true;
    }

    const storedPersonaType = options.getPersonaMemoryType?.(input.personaId) ?? null;
    const effectivePersonaType: PersonaType = storedPersonaType || 'general';

    if (!plan.counterpart) {
      const counterpartCandidates = uniqueStrings([
        ...ledgerRows.map((row) => String(row.counterpart || '').trim()),
        ...episodes.map((row) => String(row.counterpart || '').trim()),
      ]);
      const mentionedCounterpart = detectMentionedCounterpart(input.query, counterpartCandidates);
      if (mentionedCounterpart) {
        ledgerRows = ledgerRows.filter((row) =>
          isCounterpartMatch(row.counterpart, mentionedCounterpart),
        );
        episodes = episodes.filter((row) =>
          isCounterpartMatch(row.counterpart, mentionedCounterpart),
        );
      }
    }

    ledgerRows = rankLedgerByQuery(ledgerRows, input.query).slice(0, 8);
    episodes = rankEpisodesByQuery(episodes, input.query, effectivePersonaType).slice(0, 8);
    let fallbackRuleEvidence: RuleEvidenceEntry[] = [];

    if (rulesIntent) {
      const ruleLedger = ledgerRows.filter((row) => {
        if (!hasValidSourceRefs(row.sourceRefs)) return false;
        return hasRuleLikeFragments([
          ...row.decisions,
          ...row.negotiatedTerms,
          ...row.openPoints,
          ...row.actionItems,
        ]);
      });
      const ruleEpisodes = episodes.filter(
        (row) =>
          hasValidSourceRefs(row.sourceRefs) &&
          hasRuleLikeFragments([row.topicKey, row.teaser, row.episode, ...row.facts]),
      );
      ledgerRows = ruleLedger;
      episodes = ruleEpisodes;

      const fallbackEntities = options.knowledgeRepository.listEntities
        ? options.knowledgeRepository.listEntities(graphFilter, 100)
        : [];
      const fallbackEvents = options.knowledgeRepository.listEvents
        ? options.knowledgeRepository.listEvents(
            {
              userId: input.userId,
              personaId: input.personaId,
              from: plan.timeRange?.from,
              to: plan.timeRange?.to,
            },
            120,
          )
        : [];
      fallbackRuleEvidence = collectRuleFallbackEvidence(fallbackEntities, fallbackEvents);
      stageStats.graphRules = fallbackRuleEvidence.length;
    }

    stageStats.ledger = ledgerRows.length;
    stageStats.episodes = episodes.length;
    stageStats.topicFallback = usedTopicFallback ? 1 : 0;

    const includeSemantic = input.includeSemantic !== false;
    const semantic =
      includeSemantic && options.memoryService
        ? await options.memoryService.recallDetailed(input.personaId, input.query, 3, input.userId)
        : { context: '', matches: [] };
    stageStats.semantic = Math.max(0, semantic.matches.length);
    const semanticContext = buildSemanticContextForQuery(input.query, semantic);

    const hasSignals =
      stageStats.ledger > 0 ||
      stageStats.episodes > 0 ||
      stageStats.graphRules > 0 ||
      stageStats.semantic > 0 ||
      !!computedAnswerText ||
      !!entityContextSection;

    if (!hasSignals) {
      options.knowledgeRepository.insertRetrievalAudit({
        userId: input.userId,
        personaId: input.personaId,
        conversationId: input.conversationId || 'unknown-conversation',
        query: input.query,
        stageStats,
        tokenCount: 0,
        hadError: false,
      });
      if (rulesIntent) {
        return {
          context: '',
          sections: {
            answerDraft:
              'Unklar: In der Knowledge sind aktuell keine belegten Regeln mit Evidenz-Referenzen vorhanden.',
            keyDecisions: 'Unklar: Keine belegten Regel-Fakten gefunden.',
            openPoints: 'Unklar: Keine belegten offenen Regel-Punkte gefunden.',
            evidence: 'Keine belegten Evidenz-Referenzen fuer Regeln gefunden.',
          },
          references: [],
          tokenCount: 0,
        };
      }
      return {
        context: '',
        sections: { answerDraft: '', keyDecisions: '', openPoints: '', evidence: '' },
        references: [],
        tokenCount: 0,
      };
    }

    const conversationId = selectConversationId(episodes, ledgerRows) || input.conversationId;
    const messages = conversationId
      ? options.messageRepository.listMessages(conversationId, 200, undefined, input.userId)
      : [];
    stageStats.evidence = messages.length;

    const { counterpart, keyDecisionsList, openPointsList } = extractCounterpartAndLists(
      ledgerRows,
      episodes,
      plan.counterpart ?? undefined,
    );
    const mergedKeyDecisionsList = rulesIntent
      ? uniqueStrings([...keyDecisionsList, ...fallbackRuleEvidence.map((entry) => entry.text)])
      : keyDecisionsList;

    const { keyDecisions, openPoints } = filterListsForRulesIntent(
      rulesIntent,
      mergedKeyDecisionsList,
      openPointsList,
    );

    const answerDraftParts = buildAnswerDraft({
      rulesIntent,
      ledgerRows,
      episodes,
      fallbackRuleHighlights: fallbackRuleEvidence.map((entry) => entry.text),
      counterpart,
      computedAnswerText,
      entityContextSection,
      semanticContext,
      keyDecisionsList: keyDecisions,
      openPointsList: openPoints,
    });

    const { evidenceText, references } = buildEvidence(messages, episodes, ledgerRows, {
      extraRefs: fallbackRuleEvidence.flatMap((entry) => entry.refs),
      allowMessageFallback: !rulesIntent,
    });

    const hasRulesEvidence = references.length > 0;
    const binaryRecallConflict = detectBinaryRecallConflict(messages, input.query);

    const rawSections: KnowledgeRetrievalSections =
      rulesIntent && !hasRulesEvidence
        ? {
            answerDraft:
              'Unklar: In der Knowledge sind aktuell keine belegten Regeln mit Evidenz-Referenzen vorhanden.',
            keyDecisions: 'Unklar: Keine belegten Regel-Fakten gefunden.',
            openPoints: 'Unklar: Keine belegten offenen Regel-Punkte gefunden.',
            evidence: 'Keine belegten Evidenz-Referenzen fuer Regeln gefunden.',
          }
        : binaryRecallConflict.hasConflict
          ? {
              answerDraft: 'Unklar: In der Historie gibt es widerspruechliche Aussagen zur Frage.',
              keyDecisions:
                'Widerspruch erkannt: Nutzer- und Assistant-Aussagen zur gleichen Erinnerung widersprechen sich.',
              openPoints: 'Bitte den Sachverhalt kurz klaeren, damit die Erinnerung stabil wird.',
              evidence: evidenceText || 'Widerspruch erkannt, aber keine Evidenzzeilen verfuegbar.',
            }
          : {
              answerDraft: answerDraftParts.join('\n').trim(),
              keyDecisions:
                keyDecisions.join('\n').trim() || 'Keine belastbaren Entscheidungen gefunden.',
              openPoints: openPoints.join('\n').trim() || 'Keine offenen Punkte erkannt.',
              evidence: evidenceText || 'Keine direkten Evidenzstellen gefunden.',
            };

    const { context, budgetedSections, tokenCount } = calculateAndApplyBudget(rawSections, {
      query: input.query,
      counterpartAliasesLength: plan.counterpartAliases?.length ?? 0,
      stageStats,
      computedAnswerText,
      maxContextTokens,
    });

    options.knowledgeRepository.insertRetrievalAudit({
      userId: input.userId,
      personaId: input.personaId,
      conversationId: conversationId || input.conversationId || 'unknown-conversation',
      query: input.query,
      stageStats,
      tokenCount,
      hadError: false,
    });

    return {
      context,
      sections: budgetedSections,
      references: rulesIntent && !hasRulesEvidence ? [] : references,
      tokenCount,
      computedAnswer: computedAnswerText,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown retrieval error';

    options.knowledgeRepository.insertRetrievalAudit({
      userId: input.userId,
      personaId: input.personaId,
      conversationId: input.conversationId || 'unknown-conversation',
      query: input.query,
      stageStats,
      tokenCount: 0,
      hadError: true,
      errorMessage,
    });

    return {
      context: '',
      sections: { answerDraft: '', keyDecisions: '', openPoints: '', evidence: '' },
      references: [],
      tokenCount: 0,
    };
  }
}
