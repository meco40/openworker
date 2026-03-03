import { queryAll, queryOne, run, transaction } from '@/lib/db';
import type { Agent, Task } from '@/lib/types';
import { CreateTaskSchema, UpdateTaskSchema } from '@/lib/validation';
import { deleteTaskWorkspace, ensureTaskWorkspace } from '@/server/tasks/taskWorkspace';
import { hydrateTaskRelations, type TaskRowWithJoins } from '@/server/tasks/taskHydration';
import type { z } from 'zod';

type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

export class TaskNotFoundError extends Error {
  constructor(message = 'Task not found') {
    super(message);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskForbiddenError';
  }
}

export class TaskNoUpdatesError extends Error {
  constructor(message = 'No updates provided') {
    super(message);
    this.name = 'TaskNoUpdatesError';
  }
}

export interface TaskListFilters {
  status?: string | null;
  businessId?: string | null;
  workspaceId?: string | null;
  assignedAgentId?: string | null;
}

export interface UpdateTaskResult {
  task: ReturnType<typeof hydrateTaskRelations> | null;
  shouldDispatch: boolean;
  shouldAutoTest: boolean;
  previousTitle: string;
}

function getTaskWithRelations(taskId: string) {
  const task = queryOne<TaskRowWithJoins>(
    `SELECT t.*,
      aa.name as assigned_agent_name,
      aa.avatar_emoji as assigned_agent_emoji,
      ca.name as created_by_agent_name,
      ca.avatar_emoji as created_by_agent_emoji
     FROM tasks t
     LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
     LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
     WHERE t.id = ?`,
    [taskId],
  );
  return task ? hydrateTaskRelations(task) : null;
}

export function listTasks(filters: TaskListFilters) {
  let sql = `
    SELECT
      t.*,
      aa.name as assigned_agent_name,
      aa.avatar_emoji as assigned_agent_emoji,
      ca.name as created_by_agent_name,
      ca.avatar_emoji as created_by_agent_emoji
    FROM tasks t
    LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
    LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (filters.status) {
    const statuses = filters.status
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (statuses.length === 1) {
      sql += ' AND t.status = ?';
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
  }

  if (filters.businessId) {
    sql += ' AND t.business_id = ?';
    params.push(filters.businessId);
  }
  if (filters.workspaceId) {
    sql += ' AND t.workspace_id = ?';
    params.push(filters.workspaceId);
  }
  if (filters.assignedAgentId) {
    sql += ' AND t.assigned_agent_id = ?';
    params.push(filters.assignedAgentId);
  }

  sql += ' ORDER BY t.created_at DESC';

  return queryAll<TaskRowWithJoins>(sql, params).map(hydrateTaskRelations);
}

export function getTaskById(taskId: string) {
  const task = getTaskWithRelations(taskId);
  if (!task) {
    throw new TaskNotFoundError();
  }
  return task;
}

export function createTask(data: CreateTaskInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const workspaceId = data.workspace_id || 'default';
  const status = data.status || 'inbox';
  let workspaceCreated = false;

  try {
    ensureTaskWorkspace(id);
    workspaceCreated = true;

    let eventMessage = `New task: ${data.title}`;
    if (data.created_by_agent_id) {
      const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [
        data.created_by_agent_id,
      ]);
      if (creator) {
        eventMessage = `${creator.name} created task: ${data.title}`;
      }
    }

    transaction(() => {
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.title,
          data.description || null,
          status,
          data.priority || 'normal',
          data.assigned_agent_id || null,
          data.created_by_agent_id || null,
          workspaceId,
          data.business_id || 'default',
          data.due_date || null,
          now,
          now,
        ],
      );

      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          'task_created',
          data.created_by_agent_id || null,
          id,
          eventMessage,
          now,
        ],
      );
    });

    return getTaskWithRelations(id);
  } catch (error) {
    if (workspaceCreated) {
      try {
        deleteTaskWorkspace(id);
      } catch (cleanupError) {
        console.error('Failed to rollback task workspace after create error:', cleanupError);
      }
    }
    throw error;
  }
}

export function updateTask(
  taskId: string,
  data: UpdateTaskInput & { updated_by_agent_id?: string },
): UpdateTaskResult {
  const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) {
    throw new TaskNotFoundError();
  }

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];
  let shouldDispatch = false;
  let shouldAutoTest = false;

  if (data.status === 'done' && existing.status === 'review' && data.updated_by_agent_id) {
    const updatingAgent = queryOne<Agent>('SELECT is_master FROM agents WHERE id = ?', [
      data.updated_by_agent_id,
    ]);
    if (!updatingAgent || !updatingAgent.is_master) {
      throw new TaskForbiddenError('Forbidden: only the master agent can approve tasks');
    }
  }

  if (data.title !== undefined) {
    updates.push('title = ?');
    values.push(data.title);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    values.push(data.description);
  }
  if (data.priority !== undefined) {
    updates.push('priority = ?');
    values.push(data.priority);
  }
  if (data.due_date !== undefined) {
    updates.push('due_date = ?');
    values.push(data.due_date);
  }

  if (data.status !== undefined && data.status !== existing.status) {
    updates.push('status = ?');
    values.push(data.status);

    if (data.status === 'assigned' && existing.assigned_agent_id) {
      shouldDispatch = true;
    }
    if (data.status === 'testing') {
      shouldAutoTest = true;
    }

    const eventType = data.status === 'done' ? 'task_completed' : 'task_status_changed';
    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        eventType,
        taskId,
        `Task "${existing.title}" moved to ${data.status}`,
        now,
      ],
    );
  }

  if (
    data.assigned_agent_id !== undefined &&
    data.assigned_agent_id !== existing.assigned_agent_id
  ) {
    updates.push('assigned_agent_id = ?');
    values.push(data.assigned_agent_id);

    if (data.assigned_agent_id) {
      const agent = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [
        data.assigned_agent_id,
      ]);
      if (agent) {
        run(
          `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            'task_assigned',
            data.assigned_agent_id,
            taskId,
            `"${existing.title}" assigned to ${agent.name}`,
            now,
          ],
        );

        if (existing.status === 'assigned' || data.status === 'assigned') {
          shouldDispatch = true;
        }
      }
    }
  }

  if (updates.length === 0) {
    throw new TaskNoUpdatesError();
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(taskId);
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

  return {
    task: getTaskWithRelations(taskId),
    shouldDispatch,
    shouldAutoTest,
    previousTitle: existing.title,
  };
}

export function deleteTask(taskId: string) {
  const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) {
    throw new TaskNotFoundError();
  }

  transaction(() => {
    run('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
    run('DELETE FROM events WHERE task_id = ?', [taskId]);
    run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [taskId]);
    run('DELETE FROM tasks WHERE id = ?', [taskId]);
    deleteTaskWorkspace(taskId);
  });
}
