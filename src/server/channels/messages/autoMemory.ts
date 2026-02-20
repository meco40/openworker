import type { MemoryType } from '@/core/memory/types';
import type { StoredMessage } from '@/server/channels/messages/repository';
import { detectRecurrence } from '@/server/knowledge/recurrenceDetector';

export interface AutoMemoryCandidate {
  type: MemoryType;
  content: string;
  importance: number;
}

const EXPLICIT_SAVE_PATTERN = /^speichere\s+ab(?:\s*[:\-–—]\s*|\s+|$)/i;
const MAX_CANDIDATES = 4;
const MIN_MESSAGES_FOR_RECAP = 4;
const MAX_CONTENT_LENGTH = 220;

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function clipText(input: string, max = MAX_CONTENT_LENGTH): string {
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

function containsClockTimeMarker(lower: string): boolean {
  const idx = lower.indexOf('um ');
  if (idx < 0) return false;
  const tail = lower.slice(idx + 3).trimStart();
  if (!tail) return false;
  const firstToken = tail.split(/\s+/)[0] || '';
  const hourPart = firstToken.split(':')[0] || '';
  const hour = Number.parseInt(hourPart, 10);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23;
}

function containsDateMarker(lower: string): boolean {
  const idx = lower.indexOf('am ');
  if (idx < 0) return false;
  const tail = lower.slice(idx + 3).trimStart();
  if (!tail) return false;
  const firstToken = tail.split(/\s+/)[0] || '';
  const dayPart = firstToken.endsWith('.') ? firstToken.slice(0, -1) : firstToken;
  const day = Number.parseInt(dayPart, 10);
  return Number.isFinite(day) && day >= 1 && day <= 31;
}

function classifyCandidate(content: string): AutoMemoryCandidate | null {
  const text = normalizeText(content);
  if (!text || text.length < 8) return null;
  if (EXPLICIT_SAVE_PATTERN.test(text)) return null;

  const lower = text.toLowerCase();

  if (
    /\b(ich mag|ich liebe|mein lieblings|ich trinke|ich esse|ich bevorzuge|ich nutze|i like|i love|i prefer)\b/i.test(
      lower,
    )
  ) {
    const importance = /\b(immer|jeden|täglich|always|every day)\b/i.test(lower) ? 5 : 4;
    return { type: 'preference', content: clipText(text), importance };
  }

  if (/\b(ich mag nicht|ich hasse|vermeide|i dislike|i hate|avoid)\b/i.test(lower)) {
    return { type: 'avoidance', content: clipText(text), importance: 4 };
  }

  const eventKeywords = [
    'termin',
    'meeting',
    'arzt',
    'anruf',
    'deadline',
    'morgen',
    'nächste',
    'tomorrow',
    'next',
  ];
  const hasEventKeyword = eventKeywords.some((keyword) => lower.includes(keyword));
  const hasClockTime = containsClockTimeMarker(lower);
  const hasDateMarker = containsDateMarker(lower);

  if (hasEventKeyword || hasClockTime || hasDateMarker) {
    return { type: 'fact', content: clipText(text), importance: 4 };
  }

  if (
    /\b(ich bin|i am)\b/i.test(lower) &&
    /\b(ruhig|introvertiert|extrovertiert|strukturiert|kreativ|geduldig|ungeduldig)\b/i.test(lower)
  ) {
    return { type: 'personality_trait', content: clipText(text), importance: 3 };
  }

  // Recurring pattern detection (daily, weekly, monthly)
  const recurrence = detectRecurrence(text);
  if (recurrence) {
    return { type: 'workflow_pattern', content: clipText(text), importance: 4 };
  }

  return null;
}

function buildRecapCandidate(userMessages: StoredMessage[]): AutoMemoryCandidate | null {
  if (userMessages.length < MIN_MESSAGES_FOR_RECAP) return null;
  const snippets = userMessages
    .slice(-3)
    .map((message) => clipText(normalizeText(message.content), 80))
    .filter((text) => text.length > 0);

  if (snippets.length < 2) return null;

  const date =
    userMessages[userMessages.length - 1]?.createdAt?.slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const recap = `Besprochen am ${date}: ${snippets.join(' | ')}`;
  return { type: 'lesson', content: clipText(recap), importance: 2 };
}

export function isAutoSessionMemoryEnabled(): boolean {
  const mode = String(process.env.CHAT_AUTO_SESSION_MEMORY || 'heuristic').toLowerCase();
  return mode !== 'off' && mode !== 'false' && mode !== '0';
}

export function buildAutoMemoryCandidates(messages: StoredMessage[]): AutoMemoryCandidate[] {
  const userMessages = messages.filter((message) => message.role === 'user');
  if (userMessages.length === 0) return [];

  const unique = new Set<string>();
  const candidates: AutoMemoryCandidate[] = [];

  for (const message of userMessages) {
    const candidate = classifyCandidate(message.content);
    if (!candidate) continue;
    const key = `${candidate.type}:${candidate.content.toLowerCase()}`;
    if (unique.has(key)) continue;
    unique.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES - 1) {
      break;
    }
  }

  const recap = buildRecapCandidate(userMessages);
  if (recap) {
    const recapKey = `${recap.type}:${recap.content.toLowerCase()}`;
    if (!unique.has(recapKey) && candidates.length < MAX_CANDIDATES) {
      candidates.push(recap);
    }
  }

  return candidates;
}
