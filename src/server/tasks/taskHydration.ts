import type { Task } from '@/lib/types';

export interface TaskRowWithJoins extends Task {
  assigned_agent_name?: string | null;
  assigned_agent_emoji?: string | null;
  created_by_agent_name?: string | null;
  created_by_agent_emoji?: string | null;
}

export function hydrateTaskRelations(task: TaskRowWithJoins): Task {
  return {
    ...task,
    assigned_agent: task.assigned_agent_id
      ? {
          id: task.assigned_agent_id,
          name: task.assigned_agent_name ?? null,
          avatar_emoji: task.assigned_agent_emoji ?? null,
        }
      : undefined,
    created_by_agent: task.created_by_agent_id
      ? {
          id: task.created_by_agent_id,
          name: task.created_by_agent_name ?? null,
          avatar_emoji: task.created_by_agent_emoji ?? null,
        }
      : undefined,
  };
}
