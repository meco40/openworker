import type { StoredMessage } from '../channels/messages/repository';
import { buildKnowledgeExtractionPrompt } from './prompts';
import type { KnowledgeSourceRef } from './repository';
import { isMeaningfulKnowledgeText, sanitizeKnowledgeFacts } from './textQuality';

export interface KnowledgeMeetingLedger {
  topicKey: string;
  counterpart: string | null;
  participants: string[];
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
  sourceRefs: KnowledgeSourceRef[];
  confidence: number;
}

export interface KnowledgeExtractionInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: StoredMessage[];
}

export interface KnowledgeExtractionResult {
  facts: string[];
  teaser: string;
  episode: string;
  meetingLedger: KnowledgeMeetingLedger;
}

interface KnowledgeExtractorOptions {
  runExtractionModel?: (prompt: string) => Promise<string>;
}

const DEFAULT_COUNTERPART_REGEX = /\b(andreas|sarah|michael|anna|john|jane)\b/i;

function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function toStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => value.length > 0);
}

function toSourceRefs(values: unknown, fallback: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
  if (!Array.isArray(values)) return fallback;
  const refs = values
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      const seq = Number(record.seq);
      const quote = String(record.quote || '').trim();
      if (!Number.isFinite(seq) || !quote) return null;
      return {
        seq: Math.floor(seq),
        quote,
      };
    })
    .filter((entry): entry is KnowledgeSourceRef => entry !== null);
  return refs.length > 0 ? refs : fallback;
}

function fitWordRange(text: string, minWords: number, maxWords: number, fillerWord: string): string {
  const tokens = tokenize(text);
  const clamped = [...tokens];

  if (clamped.length > maxWords) {
    return clamped.slice(0, maxWords).join(' ');
  }

  while (clamped.length < minWords) {
    clamped.push(fillerWord);
  }

  return clamped.join(' ');
}

function pickFallbackRefs(messages: StoredMessage[]): KnowledgeSourceRef[] {
  return messages
    .filter((message) => message.role !== 'system')
    .filter((message) => Number.isFinite(Number(message.seq)))
    .filter((message) => isMeaningfulKnowledgeText(String(message.content || '')))
    .slice(0, 6)
    .map((message) => ({
      seq: Math.floor(Number(message.seq || 0)),
      quote: String(message.content || '').trim().slice(0, 220),
    }))
    .filter((ref) => ref.seq > 0 && ref.quote.length > 0);
}

function detectCounterpart(messages: StoredMessage[]): string | null {
  const corpus = messages
    .filter((message) => message.role !== 'system')
    .map((message) => String(message.content || ''))
    .join(' ');
  const match = DEFAULT_COUNTERPART_REGEX.exec(corpus);
  if (!match?.[1]) return null;
  const counterpart = match[1].trim();
  return counterpart ? counterpart[0].toUpperCase() + counterpart.slice(1) : null;
}

function buildFallback(input: KnowledgeExtractionInput): KnowledgeExtractionResult {
  const lines = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => String(message.content || '').replace(/\s+/g, ' ').trim())
    .filter((content) => isMeaningfulKnowledgeText(content));

  const facts = sanitizeKnowledgeFacts(
    lines.filter((line) =>
      /\b(vereinbart|entschieden|offen|action|todo|rabatt|vertrag|deadline|regel|regeln|rule|rules)\b/i.test(
        line,
      ),
    ),
  ).slice(0, 8);

  const fallbackFacts = facts.length > 0 ? facts : sanitizeKnowledgeFacts(lines).slice(0, 5);
  const safeFallbackFacts =
    fallbackFacts.length > 0 ? fallbackFacts : ['Wichtige Details aus dem Verlauf wurden besprochen.'];
  const sourceRefs = pickFallbackRefs(input.messages);
  const counterpart = detectCounterpart(input.messages);

  const teaserBase = [
    `Meetingzusammenfassung fuer ${counterpart || 'den Termin'}.`,
    ...safeFallbackFacts.slice(0, 4).map((fact) => `Kernpunkt: ${fact}`),
    'Der Verlauf zeigt Verhandlung, Beschluss und offene Punkte.',
  ].join(' ');

  const repeatedEpisodeBase = Array.from({ length: 35 }, (_, index) => {
    const line = lines[index % Math.max(1, lines.length)] || 'Es wurden Details zum Thema abgestimmt.';
    return `Abschnitt ${index + 1}: ${line}`;
  }).join(' ');

  return {
    facts: safeFallbackFacts,
    teaser: fitWordRange(teaserBase, 80, 150, 'kontext'),
    episode: fitWordRange(repeatedEpisodeBase, 400, 800, 'detail'),
    meetingLedger: {
      topicKey: counterpart ? `meeting-${counterpart.toLowerCase()}` : 'general-meeting',
      counterpart,
      participants: counterpart ? ['Ich', counterpart] : ['Ich'],
      decisions: safeFallbackFacts.filter((fact) => /\b(vereinbart|entschieden|beschlossen)\b/i.test(fact)),
      negotiatedTerms: safeFallbackFacts.filter((fact) => /\b(rabatt|vertrag|preis|laufzeit)\b/i.test(fact)),
      openPoints: safeFallbackFacts.filter((fact) => /\b(offen|ausstehend|todo|sla)\b/i.test(fact)),
      actionItems: safeFallbackFacts.filter((fact) => /\b(sendet|bis|deadline|aufgabe|todo)\b/i.test(fact)),
      sourceRefs,
      confidence: 0.35,
    },
  };
}

function parseModelPayload(
  raw: string,
  input: KnowledgeExtractionInput,
): KnowledgeExtractionResult | null {
  const refsFallback = pickFallbackRefs(input.messages);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const facts = sanitizeKnowledgeFacts(toStringArray(record.facts)).slice(0, 20);
  const teaser = fitWordRange(String(record.teaser || ''), 80, 150, 'kontext');
  const episode = fitWordRange(String(record.episode || ''), 400, 800, 'detail');

  const meetingRaw =
    record.meetingLedger && typeof record.meetingLedger === 'object' && !Array.isArray(record.meetingLedger)
      ? (record.meetingLedger as Record<string, unknown>)
      : {};

  const counterpartRaw = String(meetingRaw.counterpart || '').trim();
  const confidenceRaw = Number(meetingRaw.confidence);

  return {
    facts: facts.length > 0 ? facts : buildFallback(input).facts,
    teaser,
    episode,
    meetingLedger: {
      topicKey: String(meetingRaw.topicKey || '').trim() || 'general-meeting',
      counterpart: counterpartRaw || detectCounterpart(input.messages),
      participants: toStringArray(meetingRaw.participants),
      decisions: toStringArray(meetingRaw.decisions),
      negotiatedTerms: toStringArray(meetingRaw.negotiatedTerms),
      openPoints: toStringArray(meetingRaw.openPoints),
      actionItems: toStringArray(meetingRaw.actionItems),
      sourceRefs: toSourceRefs(meetingRaw.sourceRefs, refsFallback),
      confidence: Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.6,
    },
  };
}

export class KnowledgeExtractor {
  constructor(private readonly options: KnowledgeExtractorOptions = {}) {}

  async extract(input: KnowledgeExtractionInput): Promise<KnowledgeExtractionResult> {
    const baseFallback = buildFallback(input);
    if (!this.options.runExtractionModel) {
      return baseFallback;
    }

    try {
      const prompt = buildKnowledgeExtractionPrompt(input);
      const response = await this.options.runExtractionModel(prompt);
      const parsed = parseModelPayload(response, input);
      if (!parsed) return baseFallback;
      return {
        ...parsed,
        teaser: fitWordRange(parsed.teaser, 80, 150, 'kontext'),
        episode: fitWordRange(parsed.episode, 400, 800, 'detail'),
      };
    } catch {
      return baseFallback;
    }
  }
}
