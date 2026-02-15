import type { StoredMessage } from '../channels/messages/repository';
import type { KnowledgeRepository } from './repository';

export interface KnowledgeIngestionInput {
  conversationId: string;
  userId: string;
  personaId: string;
  messages: StoredMessage[];
  summaryText: string;
}

type IngestionRepository = Pick<
  KnowledgeRepository,
  | 'getEpisode'
  | 'insertEpisode'
  | 'updateEpisode'
  | 'getMeetingLedgerEntry'
  | 'insertMeetingLedgerEntry'
  | 'updateMeetingLedgerEntry'
>;

const STOP_WORDS = new Set([
  'ich',
  'du',
  'wir',
  'und',
  'oder',
  'aber',
  'mit',
  'über',
  'ueber',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einer',
  'einem',
  'am',
  'im',
  'in',
  'zu',
  'was',
  'wie',
  'haben',
  'hatten',
  'gesprochen',
  'letztes',
]);

function collectTopicKey(messages: StoredMessage[], summaryText: string): string {
  const fullText = `${summaryText}\n${messages.map((message) => message.content).join('\n')}`.toLowerCase();
  const tokens = fullText.match(/[a-zäöüß0-9_-]+/gi) || [];
  const counts = new Map<string, number>();
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (!token || token.length < 3 || STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  let best = 'conversation';
  let max = 0;
  for (const [token, count] of counts.entries()) {
    if (count > max) {
      best = token;
      max = count;
    }
  }
  return best;
}

function extractCounterpart(messages: StoredMessage[]): string {
  const text = messages.map((message) => message.content).join('\n');
  const match = /\bmit\s+([a-zäöüß][a-zäöüß0-9_-]{1,})\b/i.exec(text);
  if (match?.[1]) return match[1].toLowerCase();
  return 'self';
}

function buildTeaser(summaryText: string, messages: StoredMessage[]): string {
  const userSnippets = messages
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => message.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const combined = [summaryText.trim(), ...userSnippets].filter(Boolean).join(' ').trim();
  if (!combined) return 'Session recap gespeichert.';
  return combined.length > 260 ? `${combined.slice(0, 259)}…` : combined;
}

function buildSourceRefs(messages: StoredMessage[]): string[] {
  return messages
    .filter((message) => typeof message.seq === 'number')
    .map((message) => `msg:${message.seq}`)
    .slice(0, 25);
}

function pickDate(messages: StoredMessage[]): string {
  const last = messages[messages.length - 1];
  return (last?.createdAt || new Date().toISOString()).slice(0, 10);
}

function buildMeetingSlices(messages: StoredMessage[]): {
  decisions: string[];
  negotiatedTerms: string[];
  openPoints: string[];
  actionItems: string[];
} {
  const lines = messages.map((message) => message.content.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const decisions = lines.filter((line) => /\b(vereinbart|entschieden|beschlossen|agreed)\b/i.test(line)).slice(0, 6);
  const negotiatedTerms = lines
    .filter((line) => /\b(ausgehandelt|budget|preis|kondition|terms?)\b/i.test(line))
    .slice(0, 6);
  const openPoints = lines.filter((line) => /\b(offen|open point|unklar)\b/i.test(line)).slice(0, 6);
  const actionItems = lines
    .filter((line) => /\b(todo|aufgabe|nächster schritt|next step|bis\s+\w+)\b/i.test(line))
    .slice(0, 6);
  return { decisions, negotiatedTerms, openPoints, actionItems };
}

export class KnowledgeIngestionService {
  constructor(private readonly repository: IngestionRepository) {}

  ingestConversationWindow(input: KnowledgeIngestionInput): void {
    if (!input.messages.length) return;
    const fromSeq = input.messages[0]?.seq || 0;
    const toSeq = input.messages[input.messages.length - 1]?.seq || fromSeq;
    const episodeId = `episode:${input.conversationId}:${fromSeq}-${toSeq}`;
    const topicKey = collectTopicKey(input.messages, input.summaryText);
    const counterpart = extractCounterpart(input.messages);
    const date = pickDate(input.messages);
    const teaser = buildTeaser(input.summaryText, input.messages);
    const sourceRefs = buildSourceRefs(input.messages);

    const episodePayload = {
      id: episodeId,
      userId: input.userId,
      personaId: input.personaId,
      topicKey,
      counterpart,
      date,
      teaser,
      summary: input.summaryText || teaser,
      sourceRefs,
      updatedAt: new Date().toISOString(),
    };

    const existingEpisode = this.repository.getEpisode(input.userId, input.personaId, episodeId);
    if (existingEpisode) {
      this.repository.updateEpisode(episodePayload);
    } else {
      this.repository.insertEpisode(episodePayload);
    }

    const text = `${input.summaryText}\n${input.messages.map((message) => message.content).join('\n')}`.toLowerCase();
    const shouldStoreMeeting =
      /\b(meeting|termin|andreas|ausgehandelt|vereinbart)\b/i.test(text) ||
      counterpart !== 'self';
    if (!shouldStoreMeeting) return;

    const meetingId = `meeting:${input.conversationId}:${fromSeq}-${toSeq}`;
    const slices = buildMeetingSlices(input.messages);
    const meetingPayload = {
      id: meetingId,
      userId: input.userId,
      personaId: input.personaId,
      counterpart,
      topicKey,
      date,
      decisions: slices.decisions,
      negotiatedTerms: slices.negotiatedTerms,
      openPoints: slices.openPoints,
      actionItems: slices.actionItems,
      sourceRefs,
      updatedAt: new Date().toISOString(),
    };

    const existingMeeting = this.repository.getMeetingLedgerEntry(
      input.userId,
      input.personaId,
      meetingId,
    );
    if (existingMeeting) {
      this.repository.updateMeetingLedgerEntry(meetingPayload);
    } else {
      this.repository.insertMeetingLedgerEntry(meetingPayload);
    }
  }
}
