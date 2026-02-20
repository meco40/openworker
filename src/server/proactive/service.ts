import type { ProactiveRepository } from '@/server/proactive/repository';
import type { ProactiveDecision, ProactiveMessageInput, ProactiveSignalInput } from '@/server/proactive/types';

const LOOKBACK_DAYS = 30;
const SUGGEST_THRESHOLD = 0.72;
const SUGGEST_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MIN_TOPIC_SIGNAL_OCCURRENCES = 1;
const MAX_TOPICS_PER_EVALUATION = 12;

const TOPIC_STOPWORDS = new Set([
  'ich',
  'und',
  'oder',
  'aber',
  'mit',
  'ohne',
  'mein',
  'meine',
  'meinen',
  'mich',
  'mir',
  'habe',
  'hatte',
  'heute',
  'morgen',
  'gestern',
  'dass',
  'klingt',
  'interessant',
  'invest',
  'investiere',
  'investment',
  'verfolge',
  'track',
  'monitor',
  'nachrichten',
  'news',
  'preis',
  'kurse',
  'kurs',
  'daily',
  'hourly',
]);

function normalizeText(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

function nowIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function shiftIso(baseIso: string, diffMs: number): string {
  const base = new Date(baseIso).getTime();
  return new Date(base + diffMs).toISOString();
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function normalizeTopicCandidate(token: string): string | null {
  const clean = token
    .toLowerCase()
    .replace(/[^a-z0-9äöüß-]/gi, '')
    .trim();
  if (!clean || clean.length < 3) return null;
  if (TOPIC_STOPWORDS.has(clean)) return null;
  if (clean.endsWith('preis') && clean.length > 5) {
    const stripped = clean.slice(0, -5).trim();
    if (stripped.length >= 3 && !TOPIC_STOPWORDS.has(stripped)) return stripped;
  }
  if (clean.endsWith('price') && clean.length > 5) {
    const stripped = clean.slice(0, -5).trim();
    if (stripped.length >= 3 && !TOPIC_STOPWORDS.has(stripped)) return stripped;
  }
  return clean;
}

function extractTopics(text: string): string[] {
  const found = new Set<string>();

  const prepositionRegex = /\b(?:in|zu|über|ueber|about|for)\s+([a-z0-9äöüß-]{3,})/gi;
  for (const match of text.matchAll(prepositionRegex)) {
    const topic = normalizeTopicCandidate(match[1] || '');
    if (topic) found.add(topic);
  }

  const tokens = text.match(/[a-z0-9äöüß-]{3,}/gi) || [];
  for (const token of tokens) {
    const topic = normalizeTopicCandidate(token);
    if (topic) found.add(topic);
  }

  return Array.from(found);
}

function buildSignalsFromMessage(
  userId: string,
  personaId: string,
  message: ProactiveMessageInput,
  fallbackCreatedAt: string,
): ProactiveSignalInput[] {
  if (message.role !== 'user') return [];

  const text = normalizeText(message.content);
  if (!text) return [];

  const createdAt = nowIso(message.createdAt || fallbackCreatedAt);
  const signals: ProactiveSignalInput[] = [];
  const topics = extractTopics(text);
  if (topics.length === 0) return signals;

  const hasInvestIntent = hasAny(text, ['invest', 'investiere', 'investment', 'anlege']);
  const hasMonitorIntent = hasAny(text, [
    'preis',
    'kurs',
    'price',
    'track',
    'verfolge',
    'schaue',
    'beobacht',
    'monitor',
  ]);
  const hasNewsIntent = hasAny(text, ['nachricht', 'news', 'medien', 'meldung', 'bericht']);
  const hasRecurringIntent = hasAny(text, [
    'täglich',
    'taeglich',
    'jeden',
    'immer',
    'stündlich',
    'stuendlich',
    'daily',
    'hourly',
    'wöchentlich',
    'woechentlich',
    'weekly',
  ]);

  for (const topic of topics) {
    if (hasInvestIntent) {
      signals.push({
        userId,
        personaId,
        signalKey: `${topic}.invest`,
        weight: 0.7,
        source: 'chat',
        createdAt,
      });
    }
    if (hasMonitorIntent) {
      signals.push({
        userId,
        personaId,
        signalKey: `${topic}.monitor`,
        weight: 0.65,
        source: 'chat',
        createdAt,
      });
    }
    if (hasNewsIntent) {
      signals.push({
        userId,
        personaId,
        signalKey: `${topic}.news`,
        weight: 0.6,
        source: 'chat',
        createdAt,
      });
    }
    if (hasRecurringIntent) {
      signals.push({
        userId,
        personaId,
        signalKey: `${topic}.recurring`,
        weight: 0.55,
        source: 'chat',
        createdAt,
      });
    }
    if (!hasInvestIntent && !hasMonitorIntent && !hasNewsIntent && !hasRecurringIntent) {
      signals.push({
        userId,
        personaId,
        signalKey: `${topic}.mention`,
        weight: 0.2,
        source: 'chat',
        createdAt,
      });
    }
  }

  return signals;
}

function scoreTopic(
  summaryByKey: Map<string, { totalWeight: number; occurrences: number }>,
  topic: string,
): number {
  const invest = Math.max(
    0,
    Math.min(1, (summaryByKey.get(`${topic}.invest`)?.totalWeight ?? 0) / 0.7),
  );
  const monitor = Math.max(
    0,
    Math.min(1, (summaryByKey.get(`${topic}.monitor`)?.totalWeight ?? 0) / 0.65),
  );
  const news = Math.max(
    0,
    Math.min(1, (summaryByKey.get(`${topic}.news`)?.totalWeight ?? 0) / 0.55),
  );
  const recurring = Math.max(
    0,
    Math.min(1, (summaryByKey.get(`${topic}.recurring`)?.totalWeight ?? 0) / 0.45),
  );
  const mention = Math.max(
    0,
    Math.min(1, (summaryByKey.get(`${topic}.mention`)?.totalWeight ?? 0) / 0.6),
  );
  const score = invest * 0.35 + monitor * 0.27 + news * 0.2 + recurring * 0.12 + mention * 0.06;
  return Math.max(0, Math.min(1, score));
}

function topicSignalOccurrences(
  summaryByKey: Map<string, { totalWeight: number; occurrences: number }>,
  topic: string,
): number {
  const keys = ['invest', 'monitor', 'news', 'recurring', 'mention'].map(
    (suffix) => `${topic}.${suffix}`,
  );
  return keys.reduce((sum, key) => sum + (summaryByKey.get(key)?.occurrences ?? 0), 0);
}

function toReason(decision: ProactiveDecision['decision'], score: number, topic: string): string {
  const label = `topic "${topic}"`;
  if (decision === 'suggest') {
    return `Strong evidence for ${label} (score=${score.toFixed(2)}).`;
  }
  return `Not enough evidence for ${label} yet (score=${score.toFixed(2)}).`;
}

export class ProactiveGateService {
  constructor(private readonly repository: ProactiveRepository) {}

  ingestMessages(
    userId: string,
    personaId: string,
    messages: ProactiveMessageInput[],
    createdAt?: string,
  ): number {
    if (!userId || !personaId || messages.length === 0) return 0;
    const now = nowIso(createdAt);
    const signals = messages.flatMap((message) =>
      buildSignalsFromMessage(userId, personaId, message, now),
    );
    if (signals.length === 0) return 0;
    return this.repository.insertSignals(signals);
  }

  evaluate(userId: string, personaId: string, createdAt?: string): ProactiveDecision[] {
    if (!userId || !personaId) return [];

    const now = nowIso(createdAt);
    const sinceIso = shiftIso(now, -LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const summaryRows = this.repository.summarizeSignals(userId, personaId, sinceIso);
    const summaryByKey = new Map(
      summaryRows.map((item) => [
        item.signalKey,
        {
          totalWeight: item.totalWeight,
          occurrences: item.occurrences,
        },
      ]),
    );

    const recentDecisions = this.repository.listRecentDecisions(userId, personaId, 50);
    const output: ProactiveDecision[] = [];
    const topics = new Set<string>();
    for (const row of summaryRows) {
      const [topic] = row.signalKey.split('.');
      if (topic) topics.add(topic);
    }

    const rankedTopics = Array.from(topics)
      .map((topic) => ({
        topic,
        occurrences: topicSignalOccurrences(summaryByKey, topic),
      }))
      .filter((entry) => entry.occurrences >= MIN_TOPIC_SIGNAL_OCCURRENCES)
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, MAX_TOPICS_PER_EVALUATION);

    for (const { topic } of rankedTopics) {
      const score = scoreTopic(summaryByKey, topic);
      const candidateKey = `topic_watcher:${topic}`;
      const recentSuggestion = recentDecisions.find(
        (decision) =>
          decision.candidateKey === candidateKey &&
          decision.decision === 'suggest' &&
          new Date(now).getTime() - new Date(decision.createdAt).getTime() < SUGGEST_COOLDOWN_MS,
      );

      const nextDecision: ProactiveDecision['decision'] =
        score >= SUGGEST_THRESHOLD && !recentSuggestion ? 'suggest' : 'defer';

      const reason =
        recentSuggestion && score >= SUGGEST_THRESHOLD
          ? `Cooldown active for topic "${topic}".`
          : toReason(nextDecision, score, topic);

      if (nextDecision === 'suggest') {
        const inserted = this.repository.insertDecision({
          userId,
          personaId,
          candidateKey,
          decision: nextDecision,
          score,
          reason,
          createdAt: now,
        });
        output.push(inserted);
      } else {
        output.push({
          id: `preview-${candidateKey}-${now}`,
          userId,
          personaId,
          candidateKey,
          decision: nextDecision,
          score,
          reason,
          createdAt: now,
        });
      }
    }

    return output;
  }
}
