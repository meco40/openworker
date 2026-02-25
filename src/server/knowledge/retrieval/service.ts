import { planKnowledgeQuery } from '@/server/knowledge/queryPlanner';
import { computeEventAnswer } from '@/server/knowledge/eventAnswerComputer';
import type { PersonaType } from '@/server/knowledge/personaStrategies';
import type { KnowledgeEntity } from '@/server/knowledge/entityGraph';
import type { KnowledgeEvent } from '@/server/knowledge/eventTypes';
import type { StoredMessage } from '@/server/channels/messages/repository';

import type {
  KnowledgeRetrievalInput,
  KnowledgeRecallProbeInput,
  KnowledgeRetrievalSections,
  KnowledgeRetrievalResult,
  KnowledgeRetrievalServiceOptions,
} from './types';
import { uniqueStrings } from './utils/arrayUtils';
import {
  normalizeLookupText,
  detectMentionedCounterpart,
  isRulesIntentQuery,
} from './query/intentDetector';
import { extractRuleFragments, isRuleLikeStatement } from './query/rulesExtractor';
import { rankEpisodesByQuery } from './ranking/episodeRanker';
import { rankLedgerByQuery } from './ranking/ledgerRanker';
import { buildSemanticContextForQuery, formatProjectGraph } from './formatters/contextFormatter';
import { buildEvidence, type EvidenceSourceRef } from './formatters/evidenceBuilder';
import { isCounterpartMatch, selectConversationId } from './formatters/displayUtils';
import {
  buildAnswerDraft,
  filterListsForRulesIntent,
  extractCounterpartAndLists,
} from './formatters/answerDraftBuilder';
import { calculateAndApplyBudget } from './formatters/budgetCalculator';

interface RuleEvidenceEntry {
  text: string;
  refs: EvidenceSourceRef[];
}

function normalizeRuleText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeRuleText(value: string): string[] {
  return normalizeRuleText(value)
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function hasMeaningfulOverlap(left: string, right: string): boolean {
  const leftNorm = normalizeRuleText(left);
  const rightNorm = normalizeRuleText(right);
  if (!leftNorm || !rightNorm) return false;
  if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) return true;

  const leftTokens = new Set(tokenizeRuleText(leftNorm));
  const rightTokens = tokenizeRuleText(rightNorm);
  if (leftTokens.size === 0 || rightTokens.length === 0) return false;

  let overlap = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) overlap += 1;
  }

  return overlap >= 2;
}

function parseEventSeqs(sourceSeqJson: string): number[] {
  try {
    const parsed = JSON.parse(sourceSeqJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Math.floor(Number(value || 0)))
      .filter((seq) => Number.isFinite(seq) && seq > 0);
  } catch {
    return [];
  }
}

function hasValidSourceRefs(
  refs: Array<{ seq: number; quote: string }> | undefined | null,
): boolean {
  return (refs || []).some((ref) => Number(ref?.seq || 0) > 0);
}

function hasRuleLikeFragments(values: string[]): boolean {
  const normalized = values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0);
  if (normalized.some((value) => isRuleLikeStatement(value))) return true;
  return extractRuleFragments(normalized.join('\n')).length > 0;
}

const BINARY_RECALL_QUERY_PATTERN =
  /\b(waren wir|haben wir|war das|stimmt das|did we|were we|have we)\b/i;
const NEGATION_SIGNAL_PATTERN = /\b(nicht|kein|keine|keinen|keinem|nie|niemals|never|no)\b/i;
const GENERIC_QUERY_TOKENS = new Set([
  'waren',
  'haben',
  'schon',
  'mal',
  'einmal',
  'zusammen',
  'wir',
  'with',
  'ever',
  'did',
  'were',
  'have',
]);

function isBinaryRecallQuery(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  return BINARY_RECALL_QUERY_PATTERN.test(normalized);
}

function extractQueryEvidenceTokens(value: string): string[] {
  const normalized = normalizeLookupText(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  const specific = tokens.filter((token) => !GENERIC_QUERY_TOKENS.has(token));
  return specific.length > 0 ? specific : tokens;
}

function hasEvidenceTokenOverlap(text: string, tokens: string[]): boolean {
  const normalized = normalizeLookupText(text);
  if (!normalized || tokens.length === 0) return false;
  return tokens.some((token) => normalized.includes(token));
}

function detectBinaryRecallConflict(
  messages: StoredMessage[],
  query: string,
): { hasConflict: boolean; userSeqs: number[]; agentSeqs: number[] } {
  if (!isBinaryRecallQuery(query)) {
    return { hasConflict: false, userSeqs: [], agentSeqs: [] };
  }

  const tokens = extractQueryEvidenceTokens(query);
  if (tokens.length === 0) {
    return { hasConflict: false, userSeqs: [], agentSeqs: [] };
  }

  const relevant = messages.filter((message) => hasEvidenceTokenOverlap(message.content, tokens));
  const userMessages = relevant.filter((message) => message.role === 'user');
  const agentMessages = relevant.filter((message) => message.role === 'agent');

  const userSeqs = new Set<number>();
  const agentSeqs = new Set<number>();
  for (const userMessage of userMessages) {
    for (const agentMessage of agentMessages) {
      const userHasNegation = NEGATION_SIGNAL_PATTERN.test(
        normalizeLookupText(userMessage.content),
      );
      const agentHasNegation = NEGATION_SIGNAL_PATTERN.test(
        normalizeLookupText(agentMessage.content),
      );
      if (userHasNegation === agentHasNegation) {
        continue;
      }

      const userSeq = Math.floor(Number(userMessage.seq || 0));
      const agentSeq = Math.floor(Number(agentMessage.seq || 0));
      if (userSeq > 0) userSeqs.add(userSeq);
      if (agentSeq > 0) agentSeqs.add(agentSeq);
    }
  }

  return {
    hasConflict: userSeqs.size > 0 && agentSeqs.size > 0,
    userSeqs: [...userSeqs].sort((a, b) => a - b),
    agentSeqs: [...agentSeqs].sort((a, b) => a - b),
  };
}

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
    const relatedEntities = this.options.knowledgeRepository.getRelatedEntities(
      topicMatch.entity.id,
    );
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

  private collectRuleFallbackEvidence(
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
      const key = normalizeRuleText(entry.text);
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

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const plan = planKnowledgeQuery(input.query);
    const rulesIntent = isRulesIntentQuery(input.query);
    const topicFilter = plan.topic && plan.topic !== 'ausgehandelt' ? plan.topic : undefined;
    const strictTopicFilterRequested = Boolean(topicFilter);

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
      graphRules: 0,
    };

    try {
      let ledgerRows = this.options.knowledgeRepository.listMeetingLedger(filter);
      let episodes = this.options.knowledgeRepository.listEpisodes(filter);
      let usedTopicFallback = false;

      if (strictTopicFilterRequested && ledgerRows.length === 0 && episodes.length === 0) {
        const relaxedFilter = {
          ...filter,
          topicKey: undefined,
        };
        ledgerRows = this.options.knowledgeRepository.listMeetingLedger(relaxedFilter);
        episodes = this.options.knowledgeRepository.listEpisodes(relaxedFilter);
        usedTopicFallback = true;
      }

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

        const fallbackEntities = this.options.knowledgeRepository.listEntities
          ? this.options.knowledgeRepository.listEntities(graphFilter, 100)
          : [];
        const fallbackEvents = this.options.knowledgeRepository.listEvents
          ? this.options.knowledgeRepository.listEvents(
              {
                userId: input.userId,
                personaId: input.personaId,
                from: plan.timeRange?.from,
                to: plan.timeRange?.to,
              },
              120,
            )
          : [];
        fallbackRuleEvidence = this.collectRuleFallbackEvidence(fallbackEntities, fallbackEvents);
        stageStats.graphRules = fallbackRuleEvidence.length;
      }

      stageStats.ledger = ledgerRows.length;
      stageStats.episodes = episodes.length;
      stageStats.topicFallback = usedTopicFallback ? 1 : 0;

      const includeSemantic = input.includeSemantic !== false;
      const semantic = includeSemantic && this.options.memoryService
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
        stageStats.graphRules > 0 ||
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
        ? this.options.messageRepository.listMessages(conversationId, 200, undefined, input.userId)
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
                answerDraft:
                  'Unklar: In der Historie gibt es widerspruechliche Aussagen zur Frage.',
                keyDecisions:
                  'Widerspruch erkannt: Nutzer- und Assistant-Aussagen zur gleichen Erinnerung widersprechen sich.',
                openPoints: 'Bitte den Sachverhalt kurz klaeren, damit die Erinnerung stabil wird.',
                evidence:
                  evidenceText || 'Widerspruch erkannt, aber keine Evidenzzeilen verfuegbar.',
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
        maxContextTokens: this.maxContextTokens,
      });

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
        references: rulesIntent && !hasRulesEvidence ? [] : references,
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
