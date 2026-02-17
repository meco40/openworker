/**
 * Task lifecycle tracking with completion detection.
 *
 * Pure functions for detecting task completion signals in conversation text,
 * and matching them against open tasks.
 */

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'overdue' | 'cancelled';
export type TaskType = 'one_time' | 'recurring' | 'deadline' | 'preference';

export interface TrackedTask {
  id: string;
  userId: string;
  personaId: string;
  title: string;
  description: string | null;
  taskType: TaskType;
  status: TaskStatus;
  deadline: string | null;
  recurrence: string | null;
  location: string | null;
  relatedEntityId: string | null;
  createdAt: string;
  completedAt: string | null;
  sourceConversationId: string;
}

export interface TaskCompletionMatch {
  task: TrackedTask;
  matchConfidence: number;
}

const COMPLETION_SIGNALS =
  /\b(erledigt|gemacht|fertig|abgehakt|war beim|hab ich|done|geschafft|abgeschlossen)\b/i;

/**
 * Detect whether a message text signals completion of one of the open tasks.
 *
 * Returns the best-matching task with a confidence score, or null.
 * - 0.9 confidence: exact title found in text (case-insensitive)
 * - 0.7 confidence: >= 50% of title keywords (length > 3) found in text
 */
export function detectTaskCompletion(
  text: string,
  openTasks: TrackedTask[],
): TaskCompletionMatch | null {
  if (!COMPLETION_SIGNALS.test(text)) return null;

  const lower = text.toLowerCase();

  // First pass: exact title match (high confidence)
  for (const task of openTasks) {
    if (lower.includes(task.title.toLowerCase())) {
      return { task, matchConfidence: 0.9 };
    }
  }

  // Second pass: fuzzy keyword match
  for (const task of openTasks) {
    const keywords = task.title.split(/\s+/).filter((w) => w.length > 3);
    if (keywords.length === 0) continue;

    const matchCount = keywords.filter((k) => lower.includes(k.toLowerCase())).length;

    if (matchCount >= keywords.length * 0.5) {
      return { task, matchConfidence: 0.7 };
    }
  }

  return null;
}
