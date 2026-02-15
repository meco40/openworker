import type { StoredMessage } from '../channels/messages/repository';
import { planKnowledgeQuery } from './queryPlanner';
import { enforceSectionBudgets, estimateTokenCount, trimToTokenBudget } from './tokenBudget';
import type { KnowledgeEpisode, KnowledgeRepository, MeetingLedgerEntry } from './repository';

interface MemoryRecallLike {
  recallDetailed: (
    personaId: string,
    query: string,
    limit?: number,
    userId?: string,
  ) => Promise<{ context: string; matches: Array<{ node: { id: string } }> }>;
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
}

export interface KnowledgeRetrievalInput {
  userId: string;
  personaId: string;
  conversationId?: string;
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

function selectConversationId(
  inputConversationId: string | undefined,
  episodes: KnowledgeEpisode[],
  ledgerRows: MeetingLedgerEntry[],
): string | null {
  const explicit = String(inputConversationId || '').trim();
  if (explicit) return explicit;
  const fromLedger = String(ledgerRows[0]?.conversationId || '').trim();
  if (fromLedger) return fromLedger;
  const fromEpisodes = String(episodes[0]?.conversationId || '').trim();
  if (fromEpisodes) return fromEpisodes;
  return null;
}

export class KnowledgeRetrievalService {
  private readonly maxContextTokens: number;

  constructor(private readonly options: KnowledgeRetrievalServiceOptions) {
    this.maxContextTokens = Math.max(1, Math.floor(options.maxContextTokens || 1200));
  }

  async retrieve(input: KnowledgeRetrievalInput): Promise<KnowledgeRetrievalResult> {
    const plan = planKnowledgeQuery(input.query);
    const topicFilter =
      plan.topic && plan.topic !== 'ausgehandelt' ? plan.topic : undefined;

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
      const ledgerRows = this.options.knowledgeRepository.listMeetingLedger(filter);
      stageStats.ledger = ledgerRows.length;

      const episodes = this.options.knowledgeRepository.listEpisodes(filter);
      stageStats.episodes = episodes.length;

      const semantic = await this.options.memoryService.recallDetailed(
        input.personaId,
        input.query,
        3,
        input.userId,
      );
      stageStats.semantic = Math.max(0, semantic.matches.length);

      const conversationId = selectConversationId(input.conversationId, episodes, ledgerRows);
      const messages = conversationId
        ? this.options.messageRepository.listMessages(conversationId, 200, undefined, input.userId)
        : [];
      stageStats.evidence = messages.length;

      const latestEpisode = episodes[0];
      const keyDecisionsList = uniqueStrings([
        ...ledgerRows.flatMap((row) => row.decisions),
        ...ledgerRows.flatMap((row) => row.negotiatedTerms),
        ...(latestEpisode?.facts || []),
      ]);

      const openPointsList = uniqueStrings([
        ...ledgerRows.flatMap((row) => row.openPoints),
        ...ledgerRows.flatMap((row) => row.actionItems),
      ]);

      const counterpart = toDisplayName(
        ledgerRows[0]?.counterpart || latestEpisode?.counterpart || plan.counterpart,
      );
      const answerDraftParts = [
        counterpart ? `Kontext: Meeting mit ${counterpart}.` : 'Kontext: Wissensrueckgriff aktiv.',
        latestEpisode?.teaser || '',
        semantic.context || '',
      ].filter(Boolean);

      const { evidenceText, references } = buildEvidence(messages, episodes, ledgerRows);

      const rawSections: KnowledgeRetrievalSections = {
        answerDraft: answerDraftParts.join('\n').trim(),
        keyDecisions: keyDecisionsList.join('\n').trim() || 'Keine belastbaren Entscheidungen gefunden.',
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
