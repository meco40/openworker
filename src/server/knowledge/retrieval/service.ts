import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';
import { computeEventAnswer } from '@/server/knowledge/eventAnswerComputer';
import type { PersonaType } from '@/server/knowledge/personaStrategies';

import type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
} from './types';
import { uniqueStrings } from './utils/arrayUtils';
import { normalizeLookupText, detectMentionedCounterpart, isRulesIntentQuery } from './query/intentDetector';
import { isRuleLikeStatement } from './query/rulesExtractor';
import { rankEpisodesByQuery } from './ranking/episodeRanker';
import { rankLedgerByQuery } from './ranking/ledgerRanker';
import { buildSemanticContextForQuery, formatProjectGraph } from './formatters/contextFormatter';
import { buildEvidence } from './formatters/evidenceBuilder';
import { isCounterpartMatch, selectConversationId } from './formatters/displayUtils';
import {
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
} from './formatters/answerDraftBuilder';
import { calculateAndApplyBudget } from './formatters/budgetCalculator';

export class KnowledgeRetrievalService {
  private readonly maxContextTokens: number;
  private readonly counterpartCache = new Map<
    string,
    { counterparts: string[]; expiresAt: number }
  >();
  private readonly counterpartCacheTtlMs = 5 * 60 * 1000;

  constructor(private readonly options: KnowledgeRetrievalServiceOptions) {
    this.maxContextTokens = Math.max(1, Math.floor(options.maxContextTokens || 1200));
  }

  private getKnownCounterparts(userId: string, personaId: string): string[] {
    const cacheKey = `${userId}::${personaId}`;
    const now = Date.now();
    const cached = this.counterpartCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.counterparts;
    }

    const filter = { userId, personaId, limit: 60 };
    const ledgerRows = this.options.knowledgeRepository.listMeetingLedger(filter);
    const episodes = this.options.knowledgeRepository.listEpisodes(filter);

    const counterparts = uniqueStrings([
      ...ledgerRows.map((row) => String(row.counterpart || '').trim()),
      ...episodes.map((row) => String(row.counterpart || '').trim()),
    ]).filter((value) => value.length >= 2);

    this.counterpartCache.set(cacheKey, {
      counterparts,
      expiresAt: now + this.counterpartCacheTtlMs,
    });

    return counterparts;
  }

  async shouldTriggerRecall(input: KnowledgeRecallProbeInput): Promise<boolean> {
    const normalizedQuery = normalizeLookupText(input.query);
    if (!normalizedQuery) return false;

    const hasQuestionSignal =
      /[?]/.test(input.query) ||
      /^(was|wie|wann|wo|wer|warum|wieso|which|what|when|where|who)\b/i.test(normalizedQuery);
    const directiveRecallIntent =
      /\b(nenne|sag|sage|liste|list|zeige|zeig|erzaehl|erzahl|remember|recall|tell|summarize)\b/i.test(
        normalizedQuery,
      );
    const rulesIntent = isRulesIntentQuery(normalizedQuery);
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

    const knownCounterparts = this.getKnownCounterparts(input.userId, input.personaId);
    return detectMentionedCounterpart(input.query, knownCounterparts) !== null;
  }

  private resolveEntityContext(
    plan: ReturnType<typeof planKnowledgeQuery>,
    userId: string,
    personaId: string,
  ): string {
    if (
      plan.intent !== 'general_recall' ||
      !plan.topic ||
      !this.options.knowledgeRepository.resolveEntity ||
      !this.options.knowledgeRepository.getEntityWithRelations ||
      !this.options.knowledgeRepository.getRelatedEntities
    ) {
      return '';
    }

    const graphFilter = { userId, personaId };
    const topicMatch = this.options.knowledgeRepository.resolveEntity(plan.topic, graphFilter);
    if (!topicMatch || topicMatch.entity.category !== 'project') {
      return '';
    }

    const { relations } = this.options.knowledgeRepository.getEntityWithRelations(
      topicMatch.entity.id,
    );
    const relatedEntities = this.options.knowledgeRepository.getRelatedEntities(topicMatch.entity.id);
    return formatProjectGraph(topicMatch.entity.canonicalName, relations, relatedEntities);
  }

  private computeCountRecallAnswer(
    plan: ReturnType<typeof planKnowledgeQuery>,
    userId: string,
    personaId: string,
  ): string | null {
    if (
      plan.intent !== 'count_recall' ||
      !plan.eventFilter ||
      !this.options.knowledgeRepository.countUniqueDays
    ) {
      return null;
    }

    return computeEventAnswer(
      plan.eventFilter,
      { userId, personaId },
      {
        countUniqueDays: this.options.knowledgeRepository.countUniqueDays.bind(
          this.options.knowledgeRepository,
        ),
      },
    );
  }

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const plan = planKnowledgeQuery(input.query);
    const rulesIntent = isRulesIntentQuery(input.query);
    const topicFilter = plan.topic && plan.topic !== 'ausgehandelt' ? plan.topic : undefined;

    // ── Entity resolution: resolve counterpart/topic via graph ──
    const graphFilter = { userId: input.userId, personaId: input.personaId };
    if (plan.counterpart && this.options.knowledgeRepository.resolveEntity) {
      const entityMatch = this.options.knowledgeRepository.resolveEntity(
        plan.counterpart,
        graphFilter,
      );
      if (entityMatch) {
        plan.resolvedEntityId = entityMatch.entity.id;
        plan.resolvedEntityName = entityMatch.entity.canonicalName;
        const aliasNames = [entityMatch.entity.canonicalName];
        if (this.options.knowledgeRepository.getEntityWithRelations) {
          const { aliases } = this.options.knowledgeRepository.getEntityWithRelations(
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

    const computedAnswerText = this.computeCountRecallAnswer(plan, input.userId, input.personaId);
    const entityContextSection = this.resolveEntityContext(plan, input.userId, input.personaId);

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
    };

    try {
      let ledgerRows = this.options.knowledgeRepository.listMeetingLedger(filter);
      let episodes = this.options.knowledgeRepository.listEpisodes(filter);

      const storedPersonaType = this.options.getPersonaMemoryType?.(input.personaId) ?? null;
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

      if (rulesIntent) {
        const ruleLedger = ledgerRows.filter((row) =>
          isRuleLikeStatement(
            `${row.topicKey} ${row.decisions.join(' ')} ${row.negotiatedTerms.join(
              ' ',
            )} ${row.openPoints.join(' ')} ${row.actionItems.join(' ')}`,
          ),
        );
        const ruleEpisodes = episodes.filter((row) =>
          isRuleLikeStatement(
            `${row.topicKey} ${row.teaser} ${row.episode} ${row.facts.join(' ')}`,
          ),
        );
        if (ruleLedger.length > 0) ledgerRows = ruleLedger;
        if (ruleEpisodes.length > 0) episodes = ruleEpisodes;
      }

      stageStats.ledger = ledgerRows.length;
      stageStats.episodes = episodes.length;

      const semantic = this.options.memoryService
        ? await this.options.memoryService.recallDetailed(
            input.personaId,
            input.query,
            3,
            input.userId,
          )
        : { context: '', matches: [] };
      stageStats.semantic = Math.max(0, semantic.matches.length);
      const semanticContext = buildSemanticContextForQuery(input.query, semantic);

      const hasSignals =
        stageStats.ledger > 0 ||
        stageStats.episodes > 0 ||
        stageStats.semantic > 0 ||
        !!computedAnswerText ||
        !!entityContextSection;

      if (!hasSignals) {
        this.options.knowledgeRepository.insertRetrievalAudit({
          userId: input.userId,
          personaId: input.personaId,
          conversationId: input.conversationId || 'unknown-conversation',
          query: input.query,
          stageStats,
          tokenCount: 0,
          hadError: false,
        });
        return {
          context: '',
          sections: { answerDraft: '', keyDecisions: '', openPoints: '', evidence: '' },
          references: [],
          tokenCount: 0,
        };
      }

      const conversationId = selectConversationId(episodes, ledgerRows);
      const messages = conversationId
        ? this.options.messageRepository.listMessages(conversationId, 200, undefined, input.userId)
        : [];
      stageStats.evidence = messages.length;

      const { counterpart, keyDecisionsList, openPointsList } = extractCounterpartAndLists(
        ledgerRows,
        episodes,
        plan.counterpart ?? undefined,
      );

      const { keyDecisions, openPoints } = filterListsForRulesIntent(
        rulesIntent,
        keyDecisionsList,
        openPointsList,
      );

      const answerDraftParts = buildAnswerDraft({
        rulesIntent,
        ledgerRows,
        episodes,
        counterpart,
        computedAnswerText,
        entityContextSection,
        semanticContext,
        keyDecisionsList: keyDecisions,
        openPointsList: openPoints,
      });

      const { evidenceText, references } = buildEvidence(messages, episodes, ledgerRows);

      const rawSections: KnowledgeRetrievalSections = {
        answerDraft: answerDraftParts.join('\n').trim(),
        keyDecisions: keyDecisions.join('\n').trim() || 'Keine belastbaren Entscheidungen gefunden.',
        openPoints: openPoints.join('\n').trim() || 'Keine offenen Punkte erkannt.',
        evidence: evidenceText || 'Keine direkten Evidenzstellen gefunden.',
      };

      const { context, budgetedSections, tokenCount } = calculateAndApplyBudget(
        rawSections,
        {
          query: input.query,
          counterpartAliasesLength: plan.counterpartAliases?.length ?? 0,
          stageStats,
          computedAnswerText,
          maxContextTokens: this.maxContextTokens,
        },
      );

      this.options.knowledgeRepository.insertRetrievalAudit({
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
        references,
        tokenCount,
        computedAnswer: computedAnswerText,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown retrieval error';

      this.options.knowledgeRepository.insertRetrievalAudit({
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
}

// Re-export types for convenience
export type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
  MemoryRecallLike,
  MessageLookupRepository,
  RetrievalKnowledgeRepository,
} from './types';
