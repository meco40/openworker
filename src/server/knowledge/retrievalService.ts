import crypto from 'node:crypto';
import type {
  KnowledgeEpisode,
  KnowledgeMeetingLedgerEntry,
  KnowledgeRepository,
} from './repository';
import { planKnowledgeQuery } from './queryPlanner';

export interface KnowledgeRecallRequest {
  userId: string;
  personaId: string;
  query: string;
}

export interface KnowledgeRetrievalServiceOptions {
  now?: Date;
  maxContextChars?: number;
}

const DEFAULT_CONTEXT_CHARS = 4800;
const DEFAULT_CANDIDATE_LIMIT = 200;

type RetrievalRepository = Pick<
  KnowledgeRepository,
  'listEpisodes' | 'listMeetingLedgerEntries' | 'insertRetrievalAudit'
>;

function scoreEpisode(
  episode: KnowledgeEpisode,
  normalizedQuery: string,
  topic: string | null,
  counterpart: string | null,
  timeRange: { from: string; to: string } | null,
): number {
  let score = 0;
  const searchable = `${episode.topicKey} ${episode.counterpart} ${episode.teaser} ${episode.summary}`.toLowerCase();
  if (topic && (episode.topicKey.toLowerCase() === topic || searchable.includes(topic))) score += 4;
  if (counterpart && episode.counterpart.toLowerCase().includes(counterpart)) score += 3;
  if (timeRange && episode.date >= timeRange.from && episode.date <= timeRange.to) score += 2;
  if (searchable.includes(normalizedQuery)) score += 2;
  return score;
}

function scoreMeeting(
  entry: KnowledgeMeetingLedgerEntry,
  normalizedQuery: string,
  topic: string | null,
  counterpart: string | null,
  timeRange: { from: string; to: string } | null,
): number {
  let score = 0;
  const searchable =
    `${entry.topicKey} ${entry.counterpart} ${entry.decisions.join(' ')} ${entry.negotiatedTerms.join(' ')} ${entry.openPoints.join(' ')}`.toLowerCase();
  if (topic && (entry.topicKey.toLowerCase() === topic || searchable.includes(topic))) score += 4;
  if (counterpart && entry.counterpart.toLowerCase().includes(counterpart)) score += 4;
  if (timeRange && entry.date >= timeRange.from && entry.date <= timeRange.to) score += 2;
  if (searchable.includes(normalizedQuery)) score += 2;
  return score;
}

function clip(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1)}…`;
}

export class KnowledgeRetrievalService {
  private readonly now: Date;
  private readonly maxContextChars: number;

  constructor(
    private readonly repository: RetrievalRepository,
    options: KnowledgeRetrievalServiceOptions = {},
  ) {
    this.now = options.now || new Date();
    this.maxContextChars = options.maxContextChars || DEFAULT_CONTEXT_CHARS;
  }

  buildRecallContext(input: KnowledgeRecallRequest): string | null {
    const plan = planKnowledgeQuery(input.query, this.now);
    const episodes = this.repository.listEpisodes(input.userId, input.personaId, DEFAULT_CANDIDATE_LIMIT);
    const meetings = this.repository.listMeetingLedgerEntries(
      input.userId,
      input.personaId,
      DEFAULT_CANDIDATE_LIMIT,
    );

    const rankedEpisodes = episodes
      .map((episode) => ({
        episode,
        score: scoreEpisode(
          episode,
          plan.normalizedQuery,
          plan.topic,
          plan.counterpart,
          plan.timeRange,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const rankedMeetings = meetings
      .map((entry) => ({
        entry,
        score: scoreMeeting(
          entry,
          plan.normalizedQuery,
          plan.topic,
          plan.counterpart,
          plan.timeRange,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (rankedEpisodes.length === 0 && rankedMeetings.length === 0) {
      return null;
    }

    const lines: string[] = [];
    if (rankedMeetings.length > 0) {
      lines.push('Meeting Ledger:');
      for (const { entry } of rankedMeetings) {
        lines.push(`- ${entry.date} mit ${entry.counterpart} (${entry.topicKey})`);
        if (entry.decisions.length > 0) lines.push(`  Entscheidungen: ${entry.decisions.join('; ')}`);
        if (entry.negotiatedTerms.length > 0) lines.push(`  Ausgehandelt: ${entry.negotiatedTerms.join('; ')}`);
        if (entry.openPoints.length > 0) lines.push(`  Offen: ${entry.openPoints.join('; ')}`);
        if (entry.actionItems.length > 0) lines.push(`  Actions: ${entry.actionItems.join('; ')}`);
        if (entry.sourceRefs.length > 0) lines.push(`  Quellen: ${entry.sourceRefs.join(', ')}`);
      }
    }

    if (rankedEpisodes.length > 0) {
      lines.push('Episoden:');
      for (const { episode } of rankedEpisodes) {
        lines.push(`- ${episode.date} [${episode.topicKey}] ${episode.teaser}`);
        lines.push(`  Details: ${episode.summary}`);
        if (episode.sourceRefs.length > 0) lines.push(`  Quellen: ${episode.sourceRefs.join(', ')}`);
      }
    }

    const context = clip(lines.join('\n'), this.maxContextChars);

    try {
      this.repository.insertRetrievalAudit({
        id: crypto.randomUUID(),
        userId: input.userId,
        personaId: input.personaId,
        queryText: input.query,
        counterpart: plan.counterpart,
        topicKey: plan.topic,
        date: plan.timeRange?.to || null,
        resultIds: [
          ...rankedMeetings.map(({ entry }) => entry.id),
          ...rankedEpisodes.map(({ episode }) => episode.id),
        ],
      });
    } catch {
      // Retrieval audit is best-effort and must not break chat recall.
    }

    return context;
  }
}
