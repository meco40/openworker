import { detectTaskCompletion, type TrackedTask } from '@/server/knowledge/taskTracker';
import type { IngestionWindow } from '@/server/knowledge/ingestionCursor';
import type { MemoryServiceLike } from './types';
import { MEM0_RATE_LIMIT_DELAY_MS, DEFAULT_TOPIC_KEY } from './constants';
import { createMemoryIdempotencyKey } from '@/server/memory/idempotency';

export interface TaskCompletionResult {
  task: TrackedTask;
  matchConfidence: number;
  stored: boolean;
}

export interface TaskCompletionContext {
  userId: string;
  personaId: string;
  conversationId: string;
  topicKey?: string;
}

/**
 * Detect task completions from user messages and store them to Mem0.
 */
export async function storeTaskCompletions(
  memoryService: MemoryServiceLike | null | undefined,
  window: IngestionWindow,
  actionItems: string[],
  context: TaskCompletionContext,
): Promise<TaskCompletionResult[]> {
  if (!memoryService || actionItems.length === 0) {
    return [];
  }

  const { userId, personaId, conversationId } = context;
  const topicKey = String(context.topicKey || '').trim() || DEFAULT_TOPIC_KEY;

  // Create TrackedTask objects from action items
  const openTasks: TrackedTask[] = actionItems.map((item, idx) => ({
    id: `action-${idx}`,
    userId,
    personaId,
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
    sourceConversationId: conversationId,
  }));

  const results: TaskCompletionResult[] = [];

  for (const msg of window.messages) {
    if (msg.role !== 'user') continue;
    const completionMatch = detectTaskCompletion(String(msg.content || ''), openTasks);
    if (completionMatch) {
      const result: TaskCompletionResult = {
        task: completionMatch.task,
        matchConfidence: completionMatch.matchConfidence,
        stored: false,
      };

      try {
        await new Promise((resolve) => setTimeout(resolve, MEM0_RATE_LIMIT_DELAY_MS));
        const taskContent = `Aufgabe erledigt: ${completionMatch.task.title}`;
        const taskMetadata = {
          topicKey,
          conversationId,
          sourceType: 'task_completion',
          artifactType: 'task_status',
          taskTitle: completionMatch.task.title,
          completionConfidence: completionMatch.matchConfidence,
          lifecycleStatus: 'confirmed',
          idempotencyKey: createMemoryIdempotencyKey([
            'task-completion',
            userId,
            personaId,
            conversationId,
            completionMatch.task.title,
          ]),
        };
        if (memoryService.storeMemory) {
          await memoryService.storeMemory({
            personaId,
            type: 'fact',
            content: taskContent,
            importance: 4,
            userId,
            metadata: taskMetadata,
          });
        } else {
          await memoryService.store(personaId, 'fact', taskContent, 4, userId, taskMetadata);
        }
        result.stored = true;
      } catch {
        // Task completion Mem0 failures are non-critical
      }

      results.push(result);
    }
  }

  return results;
}

// Re-export types
export type { TrackedTask } from '@/server/knowledge/taskTracker';
