import type { StoredMessage } from '../channels/messages/repository';
import { planKnowledgeQuery } from './queryPlanner';
import { enforceSectionBudgets, estimateTokenCount, trimToTokenBudget } from './tokenBudget';
import type { KnowledgeEpisode, KnowledgeRepository, MeetingLedgerEntry } from './repository';
import { computeEventAnswer } from './eventAnswerComputer';
import type { EntityGraphFilter, EntityLookupResult } from './entityGraph';
import { adjustRecallScore } from './recallScoring';

interface MemoryRecallLike {
  recallDetailed: (
    personaId: string,
    query: string,
    limit?: number,
    userId?: string,
  ) => Promise<{ context: string; matches: Array<{ node: { id: string; content?: string } }> }>;
}

interface MessageLookupRepository {
  listMessages: (
    conversationId: string,
    limit?: number,
    before?: string,
    userId?: string,
  ) => StoredMessage[];
}

interface RetrievalKnowledgeRepository {
  listMeetingLedger: KnowledgeRepository['listMeetingLedger'];
  listEpisodes: KnowledgeRepository['listEpisodes'];
  insertRetrievalAudit: KnowledgeRepository['insertRetrievalAudit'];
  countUniqueDays?: KnowledgeRepository['countUniqueDays'];
  // Entity Graph (optional)
  resolveEntity?: (text: string, filter: EntityGraphFilter) => EntityLookupResult | null;
  getEntityWithRelations?: KnowledgeRepository['getEntityWithRelations'];
  getRelatedEntities?: KnowledgeRepository['getRelatedEntities'];
}

export interface KnowledgeRetrievalInput {
  userId: string;
  personaId: string;
  conversationId?: string;
  query: string;
}

export interface KnowledgeRecallProbeInput {
  userId: string;
  personaId: string;
  query: string;
}

export interface KnowledgeRetrievalSections {
  [key: string]: string;
  answerDraft: string;
  keyDecisions: string;
  openPoints: string;
  evidence: string;
}

export interface KnowledgeRetrievalResult {
  context: string;
  sections: KnowledgeRetrievalSections;
  references: string[];
  tokenCount: number;
  computedAnswer?: string | null;
}

export interface KnowledgeRetrievalServiceOptions {
  maxContextTokens: number;
  knowledgeRepository: RetrievalKnowledgeRepository;
  memoryService: MemoryRecallLike;
  messageRepository: MessageLookupRepository;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

const RULES_WORD_PATTERN =
  /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i;

function isRulesIntentQuery(query: string): boolean {
  return RULES_WORD_PATTERN.test(normalizeLookupText(query));
}

function containsRulesWord(value: string): boolean {
  return RULES_WORD_PATTERN.test(normalizeLookupText(value));
}

function truncateText(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function isRuleLikeStatement(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  if (
    /\b(ohne|kein|keine|keinen|nicht)\b.{0,24}\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/^\s*\d+\s*[.)-]/.test(value)) return true;
  if (/^\s*(regeln?|rules?|richtlinien?|vorgaben?)\b.{0,24}[:\-]/i.test(value)) return true;
  if (
    containsRulesWord(normalized) &&
    /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b.{0,28}(\d+\s*[.)]|gilt|gelten|lauten|sind)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function extractRuleFragments(text: string, maxFragments = 6): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, ' ').trim();

  const numberedRuleCandidates: string[] = [];
  const rulesHeaderMatch = /(regeln?|rules?|richtlinien?|vorgaben?)\s*:/i.exec(compact);
  const numberedScanSource = rulesHeaderMatch ? compact.slice(rulesHeaderMatch.index) : compact;
  const numberedParts = numberedScanSource.split(/\s(?=\d+\s*[.)-]\s)/);
  for (const part of numberedParts) {
    let candidate = part
      .replace(/^(regeln?|rules?|richtlinien?|vorgaben?)\s*:\s*/i, '')
      .replace(/^Abschnitt\s+\d+:\s*/i, '')
      .trim();
    if (!/^\d+\s*[.)-]\s+/.test(candidate)) continue;
    candidate = truncateText(candidate, 220);
    if (candidate.replace(/[0-9.\-\s]/g, '').length < 4) continue;
    numberedRuleCandidates.push(candidate);
    if (numberedRuleCandidates.length >= maxFragments) break;
  }
  if (numberedRuleCandidates.length > 0) {
    return uniqueStrings(numberedRuleCandidates);
  }

  const segments = raw
    .split(/\r?\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^Abschnitt\s+\d+:\s*/i, '').trim())
    .filter((part) => part.length > 0);

  const picks: string[] = [];
  for (const segment of segments) {
    if (/^\s*\d+\s*[.)-]?\s*$/.test(segment)) continue;
    if (segment.replace(/[0-9.\-\s]/g, '').length < 4) continue;
    if (
      segment.length > 260 &&
      !/^\s*(regeln?|rules?|richtlinien?|vorgaben?)\b/i.test(segment) &&
      !/^\s*\d+\s*[.)-]/.test(segment)
    ) {
      continue;
    }
    if (!isRuleLikeStatement(segment)) continue;
    picks.push(truncateText(segment, 220));
    if (picks.length >= maxFragments) break;
  }
  return uniqueStrings(picks);
}

function tokenizeQueryForRanking(query: string): string[] {
  const normalized = normalizeLookupText(query);
  const stopwords = new Set([
    'die',
    'der',
    'das',
    'ein',
    'eine',
    'und',
    'oder',
    'mit',
    'von',
    'zu',
    'an',
    'mir',
    'du',
    'ich',
    'was',
    'wie',
    'wann',
    'warum',
    'wieso',
    'nenne',
    'sage',
    'sag',
    'zeige',
    'bitte',
  ]);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopwords.has(token));
}

function computeTokenOverlapScore(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const normalizedText = normalizeLookupText(text);
  if (!normalizedText) return 0;
  let score = 0;
  for (const token of tokens) {
    if (normalizedText.includes(token)) score += 1;
  }
  return score;
}

function computeEpisodeAge(updatedAt: string | null | undefined): number {
  const ts = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(ts)) return 365;
  return Math.max(0, (Date.now() - ts) / 86_400_000);
}

function rankEpisodesByQuery(episodes: KnowledgeEpisode[], query: string): KnowledgeEpisode[] {
  const tokens = tokenizeQueryForRanking(query);
  if (tokens.length === 0) return episodes;
  return [...episodes].sort((left, right) => {
    const leftOverlap = computeTokenOverlapScore(
      `${left.topicKey} ${left.teaser} ${left.episode} ${(left.facts || []).join(' ')}`,
      tokens,
    );
    const rightOverlap = computeTokenOverlapScore(
      `${right.topicKey} ${right.teaser} ${right.episode} ${(right.facts || []).join(' ')}`,
      tokens,
    );
    // Blend overlap with freshness decay via adjustRecallScore
    const leftScore = adjustRecallScore({
      baseScore: leftOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(left.updatedAt),
    });
    const rightScore = adjustRecallScore({
      baseScore: rightOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(right.updatedAt),
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return Date.parse(String(right.updatedAt || '')) - Date.parse(String(left.updatedAt || ''));
  });
}

function rankLedgerByQuery(ledgerRows: MeetingLedgerEntry[], query: string): MeetingLedgerEntry[] {
  const tokens = tokenizeQueryForRanking(query);
  if (tokens.length === 0) return ledgerRows;
  return [...ledgerRows].sort((left, right) => {
    const leftOverlap = computeTokenOverlapScore(
      `${left.topicKey} ${left.counterpart || ''} ${left.decisions.join(' ')} ${left.negotiatedTerms.join(
        ' ',
      )} ${left.openPoints.join(' ')} ${left.actionItems.join(' ')}`,
      tokens,
    );
    const rightOverlap = computeTokenOverlapScore(
      `${right.topicKey} ${right.counterpart || ''} ${right.decisions.join(
        ' ',
      )} ${right.negotiatedTerms.join(' ')} ${right.openPoints.join(' ')} ${right.actionItems.join(' ')}`,
      tokens,
    );
    // Blend overlap with freshness decay via adjustRecallScore
    const leftScore = adjustRecallScore({
      baseScore: leftOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(left.updatedAt),
    });
    const rightScore = adjustRecallScore({
      baseScore: rightOverlap || 0.1,
      confidence: 0.5,
      ageDays: computeEpisodeAge(right.updatedAt),
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return Date.parse(String(right.updatedAt || '')) - Date.parse(String(left.updatedAt || ''));
  });
}

function buildSemanticContextForQuery(
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

function normalizeLookupText(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectMentionedCounterpart(query: string, candidates: string[]): string | null {
  const queryTokens = new Set(
    normalizeLookupText(query)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
  if (queryTokens.size === 0) return null;

  const orderedCandidates = uniqueStrings(candidates)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const candidate of orderedCandidates) {
    const tokens = normalizeLookupText(candidate)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
    if (tokens.length === 0) continue;
    const allTokensMatch = tokens.every((token) => queryTokens.has(token));
    if (allTokensMatch) return candidate;
  }

  return null;
}

function isCounterpartMatch(value: string | null | undefined, counterpart: string): boolean {
  const left = normalizeLookupText(String(value || ''));
  const right = normalizeLookupText(counterpart);
  return Boolean(left && right && left === right);
}

function toDisplayName(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildEvidence(
  messages: StoredMessage[],
  episodes: KnowledgeEpisode[],
  ledgerRows: MeetingLedgerEntry[],
): { evidenceText: string; references: string[] } {
  const refs = [
    ...ledgerRows.flatMap((row) => row.sourceRefs || []),
    ...episodes.flatMap((row) => row.sourceRefs || []),
  ]
    .map((ref) => ({
      seq: Math.floor(Number(ref.seq || 0)),
      quote: String(ref.quote || '').trim(),
    }))
    .filter((ref) => ref.seq > 0 && ref.quote.length > 0);

  const dedupedRefs = uniqueStrings(refs.map((ref) => `${ref.seq}:${ref.quote}`)).map((entry) => {
    const split = entry.indexOf(':');
    return {
      seq: Number(entry.slice(0, split)),
      quote: entry.slice(split + 1),
    };
  });

  const bySeq = new Map<number, StoredMessage>();
  for (const message of messages) {
    const seq = Math.floor(Number(message.seq || 0));
    if (!Number.isFinite(seq) || seq <= 0) continue;
    bySeq.set(seq, message);
  }

  const evidenceLines: string[] = [];
  const references: string[] = [];
  for (const ref of dedupedRefs.slice(0, 8)) {
    const message = bySeq.get(ref.seq);
    const text = message ? String(message.content || '').trim() : ref.quote;
    const line = `- [seq:${ref.seq}] ${text || ref.quote}`;
    evidenceLines.push(line);
    references.push(`seq:${ref.seq}`);
  }

  if (evidenceLines.length === 0) {
    for (const message of messages.slice(0, 4)) {
      const seq = Math.floor(Number(message.seq || 0));
      if (!Number.isFinite(seq) || seq <= 0) continue;
      evidenceLines.push(`- [seq:${seq}] ${String(message.content || '').trim()}`);
      references.push(`seq:${seq}`);
    }
  }

  return {
    evidenceText: evidenceLines.join('\n'),
    references,
  };
}

function formatProjectGraph(
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

function selectConversationId(
  episodes: KnowledgeEpisode[],
  ledgerRows: MeetingLedgerEntry[],
): string | null {
  const fromLedger = String(ledgerRows[0]?.conversationId || '').trim();
  if (fromLedger) return fromLedger;
  const fromEpisodes = String(episodes[0]?.conversationId || '').trim();
  if (fromEpisodes) return fromEpisodes;
  return null;
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

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const plan = planKnowledgeQuery(input.query);
    const rulesIntent = isRulesIntentQuery(input.query);
    const topicFilter = plan.topic && plan.topic !== 'ausgehandelt' ? plan.topic : undefined;

    // ── Entity resolution: resolve counterpart/topic via graph ──
    const graphFilter: EntityGraphFilter = {
      userId: input.userId,
      personaId: input.personaId,
    };
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

        // Override eventFilter counterpart with resolved canonical name
        if (plan.eventFilter) {
          plan.eventFilter.counterpartEntity = entityMatch.entity.canonicalName;
        }
      }
    }

    // ── Fast-path: count_recall with event aggregation ─────────
    let computedAnswerText: string | null = null;
    if (
      plan.intent === 'count_recall' &&
      plan.eventFilter &&
      this.options.knowledgeRepository.countUniqueDays
    ) {
      computedAnswerText = computeEventAnswer(
        plan.eventFilter,
        { userId: input.userId, personaId: input.personaId },
        {
          countUniqueDays: this.options.knowledgeRepository.countUniqueDays.bind(
            this.options.knowledgeRepository,
          ),
        },
      );
    }

    // ── Project entity context for general queries ─────────────
    let entityContextSection = '';
    if (
      plan.intent === 'general_recall' &&
      plan.topic &&
      this.options.knowledgeRepository.resolveEntity &&
      this.options.knowledgeRepository.getEntityWithRelations &&
      this.options.knowledgeRepository.getRelatedEntities
    ) {
      const topicMatch = this.options.knowledgeRepository.resolveEntity(plan.topic, graphFilter);
      if (topicMatch && topicMatch.entity.category === 'project') {
        const { relations } = this.options.knowledgeRepository.getEntityWithRelations(
          topicMatch.entity.id,
        );
        const relatedEntities = this.options.knowledgeRepository.getRelatedEntities(
          topicMatch.entity.id,
        );
        entityContextSection = formatProjectGraph(
          topicMatch.entity.canonicalName,
          relations,
          relatedEntities,
        );
      }
    }

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

    let hadError = false;
    let errorMessage: string | null = null;

    try {
      let ledgerRows = this.options.knowledgeRepository.listMeetingLedger(filter);
      let episodes = this.options.knowledgeRepository.listEpisodes(filter);

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
      episodes = rankEpisodesByQuery(episodes, input.query).slice(0, 8);

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

      const semantic = await this.options.memoryService.recallDetailed(
        input.personaId,
        input.query,
        3,
        input.userId,
      );
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
          sections: {
            answerDraft: '',
            keyDecisions: '',
            openPoints: '',
            evidence: '',
          },
          references: [],
          tokenCount: 0,
        };
      }

      const conversationId = selectConversationId(episodes, ledgerRows);
      const messages = conversationId
        ? this.options.messageRepository.listMessages(conversationId, 200, undefined, input.userId)
        : [];
      stageStats.evidence = messages.length;

      const latestEpisode = episodes[0];
      let keyDecisionsList = uniqueStrings([
        ...ledgerRows.flatMap((row) => row.decisions),
        ...ledgerRows.flatMap((row) => row.negotiatedTerms),
        ...(latestEpisode?.facts || []),
      ]);

      let openPointsList = uniqueStrings([
        ...ledgerRows.flatMap((row) => row.openPoints),
        ...ledgerRows.flatMap((row) => row.actionItems),
      ]);

      if (rulesIntent) {
        keyDecisionsList = keyDecisionsList.filter((entry) => isRuleLikeStatement(entry));
        openPointsList = openPointsList.filter((entry) => isRuleLikeStatement(entry));
      }

      const counterpart = toDisplayName(
        ledgerRows[0]?.counterpart || latestEpisode?.counterpart || plan.counterpart,
      );
      const ruleHighlights = rulesIntent
        ? uniqueStrings([
            ...keyDecisionsList,
            ...openPointsList,
            ...episodes.flatMap((episode) =>
              extractRuleFragments(
                `${episode.teaser || ''}\n${episode.episode || ''}\n${(episode.facts || []).join('\n')}`,
              ),
            ),
            ...ledgerRows.flatMap((row) =>
              extractRuleFragments(
                `${row.decisions.join('\n')}\n${row.negotiatedTerms.join('\n')}\n${row.openPoints.join(
                  '\n',
                )}\n${row.actionItems.join('\n')}`,
              ),
            ),
            ...extractRuleFragments(semanticContext),
          ]).slice(0, 8)
        : [];

      const answerDraftParts = rulesIntent
        ? ['Kontext: Regelwissen aus Historie.', ...ruleHighlights.map((entry) => `- ${entry}`)]
        : [
            ...(computedAnswerText ? [computedAnswerText] : []),
            ...(entityContextSection ? [`[Entity-Kontext]\n${entityContextSection}`] : []),
            counterpart
              ? `Kontext: Meeting mit ${counterpart}.`
              : 'Kontext: Wissensrueckgriff aktiv.',
            latestEpisode?.teaser || '',
            semanticContext || '',
          ];

      const { evidenceText, references } = buildEvidence(messages, episodes, ledgerRows);

      const rawSections: KnowledgeRetrievalSections = {
        answerDraft: answerDraftParts.join('\n').trim(),
        keyDecisions:
          keyDecisionsList.join('\n').trim() || 'Keine belastbaren Entscheidungen gefunden.',
        openPoints: openPointsList.join('\n').trim() || 'Keine offenen Punkte erkannt.',
        evidence: evidenceText || 'Keine direkten Evidenzstellen gefunden.',
      };

      const budgetedSections = enforceSectionBudgets(rawSections, this.maxContextTokens, {
        answerDraft: 0.4,
        keyDecisions: 0.25,
        openPoints: 0.15,
        evidence: 0.2,
      });

      let context = [
        `AnswerDraft:\n${budgetedSections.answerDraft}`,
        `KeyDecisions:\n${budgetedSections.keyDecisions}`,
        `OpenPoints:\n${budgetedSections.openPoints}`,
        `Evidence:\n${budgetedSections.evidence}`,
      ].join('\n\n');

      if (estimateTokenCount(context) > this.maxContextTokens) {
        context = trimToTokenBudget(context, this.maxContextTokens);
      }

      const tokenCount = estimateTokenCount(context);

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
      hadError = true;
      errorMessage = error instanceof Error ? error.message : 'Unknown retrieval error';

      this.options.knowledgeRepository.insertRetrievalAudit({
        userId: input.userId,
        personaId: input.personaId,
        conversationId: input.conversationId || 'unknown-conversation',
        query: input.query,
        stageStats,
        tokenCount: 0,
        hadError,
        errorMessage,
      });

      return {
        context: '',
        sections: {
          answerDraft: '',
          keyDecisions: '',
          openPoints: '',
          evidence: '',
        },
        references: [],
        tokenCount: 0,
      };
    }
  }
}
