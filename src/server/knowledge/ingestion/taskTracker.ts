import { detectTaskCompletion } from '@/server/knowledge/taskTracker';
import type { TrackedTask } from '@/server/knowledge/taskTracker';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';

export interface TaskCompletionResult {
  task: TrackedTask;
  matchConfidence: number;
}

/**
 * Detect task completions from user messages against open action items.
 * Scans user messages for completion signals against open tasks.
 */
export function detectTaskCompletions(
  window: IngestionWindow,
  actionItems: string[],
): TaskCompletionResult[] {
  if (actionItems.length === 0) return [];

  const openTasks: TrackedTask[] = actionItems.map((item, idx) => ({
    id: `action-${idx}`,
    userId: window.userId,
    personaId: window.personaId,
    title: item,
    description: null,
    taskType: 'one_time' as const,
    status: 'open' as const,
    deadline: null,
    recurrence: null,
    location: null,
    relatedEntityId: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    sourceConversationId: window.conversationId,
  }));

  const completions: TaskCompletionResult[] = [];

  for (const msg of window.messages) {
    if (msg.role !== 'user') continue;
    const completionMatch = detectTaskCompletion(String(msg.content || ''), openTasks);
    if (completionMatch) {
      completions.push(completionMatch);
    }
  }

  return completions;
}

// Re-export types and functions from the base task tracker
export type { TrackedTask } from '@/server/knowledge/taskTracker';
export { detectTaskCompletion } from '@/server/knowledge/taskTracker';
