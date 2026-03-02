/**
 * History summarizer — builds a rolling history summary from conversation summaries.
 *
 * Pure functions for chronological formatting, week grouping, and budget truncation.
 */

import { formatDateDE } from '@/shared/lib/text';

export interface ConversationSummary {
  id: string;
  userId: string;
  personaId: string;
  conversationId: string;
  summaryText: string;
  keyTopics: string[];
  entitiesMentioned: string[];
  emotionalTone: string | null;
  messageCount: number;
  timeRangeStart: string;
  timeRangeEnd: string;
  createdAt: string;
}

/**
 * Get ISO week number for a date.
 */
function getISOWeek(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Get year + week key for grouping.
 */
function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-W${String(getISOWeek(d)).padStart(2, '0')}`;
}

/**
 * Group summaries by ISO calendar week.
 * Returns arrays of summaries, one per week, sorted chronologically.
 */
export function groupByWeek(summaries: ConversationSummary[]): ConversationSummary[][] {
  if (summaries.length === 0) return [];

  const sorted = [...summaries].sort(
    (a, b) => new Date(a.timeRangeStart).getTime() - new Date(b.timeRangeStart).getTime(),
  );

  const groups = new Map<string, ConversationSummary[]>();
  for (const s of sorted) {
    const key = weekKey(s.timeRangeStart);
    const group = groups.get(key);
    if (group) {
      group.push(s);
    } else {
      groups.set(key, [s]);
    }
  }

  return Array.from(groups.values());
}

/**
 * Truncate a string to a maximum length, adding "..." at the end if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Deduplicate strings.
 */
function unique(value: string, index: number, self: string[]): boolean {
  return self.indexOf(value) === index;
}

/**
 * Build a rolling history summary from conversation summaries.
 * Used as early system message injection for long-term context.
 *
 * Groups summaries by week, formats chronologically, and truncates to budget.
 */
export function buildHistorySummary(
  summaries: ConversationSummary[],
  _personaName: string,
  budgetChars: number,
): string {
  if (summaries.length === 0) return '';

  const header = 'Bisheriger Verlauf mit dem User (aeltere Sessions):';

  const weeks = groupByWeek(summaries);
  const weekLines = weeks.map((week) => {
    const startDate = formatDateDE(week[0].timeRangeStart);
    const endDate = formatDateDE(week[week.length - 1].timeRangeStart);
    const dateRange = startDate === endDate ? startDate : `${startDate}-${endDate}`;
    const topics = week.flatMap((s) => s.keyTopics).filter(unique);
    const summaryTexts = week.map((s) => s.summaryText).join(' ');
    return `${dateRange}: ${summaryTexts} [Themen: ${topics.join(', ')}]`;
  });

  return truncate(`${header}\n${weekLines.join('\n')}`, budgetChars);
}
