import type { ScheduledTask } from '@/shared/domain/types';

export interface CoreTaskScheduleArgs {
  time_iso?: string;
  message?: string;
}

export function parseTaskScheduleArgs(args: unknown): CoreTaskScheduleArgs {
  if (!args || typeof args !== 'object') {
    return {};
  }

  const typed = args as Record<string, unknown>;
  return {
    time_iso: typeof typed.time_iso === 'string' ? typed.time_iso : undefined,
    message: typeof typed.message === 'string' ? typed.message : undefined,
  };
}

export function markDueTasksTriggered(
  tasks: ScheduledTask[],
  now: Date = new Date(),
): ScheduledTask[] {
  return tasks.map((task) =>
    task.status === 'pending' && new Date(task.targetTime) <= now
      ? { ...task, status: 'triggered' }
      : task,
  );
}

export function getDuePendingTasks(
  tasks: ScheduledTask[],
  now: Date = new Date(),
): ScheduledTask[] {
  return tasks.filter((task) => task.status === 'pending' && new Date(task.targetTime) <= now);
}
