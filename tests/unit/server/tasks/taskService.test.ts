import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  TaskNotFoundError,
  TaskForbiddenError,
  TaskNoUpdatesError,
} from '@/server/tasks/taskService';
import * as db from '@/lib/db';
import type { Task } from '@/lib/types';

vi.mock('@/lib/db', () => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((fn) => fn()),
}));

vi.mock('@/server/tasks/taskWorkspace', () => ({
  deleteTaskWorkspace: vi.fn(),
  ensureTaskWorkspace: vi.fn(),
}));

vi.mock('@/server/tasks/taskHydration', () => ({
  hydrateTaskRelations: vi.fn((task) => task),
}));

const mockQueryAll = vi.mocked(db.queryAll);
const mockQueryOne = vi.mocked(db.queryOne);
const mockRun = vi.mocked(db.run);

describe('taskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listTasks', () => {
    it('returns all tasks when no filters provided', () => {
      mockQueryAll.mockReturnValue([{ id: '1', title: 'Task 1' }] as unknown as Task[]);
      const result = listTasks({});
      expect(result).toHaveLength(1);
      expect(mockQueryAll).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        expect.any(Array),
      );
    });

    it('filters by single status', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({ status: 'inbox' });
      expect(mockQueryAll).toHaveBeenCalledWith(expect.stringContaining('AND t.status = ?'), [
        'inbox',
      ]);
    });

    it('filters by multiple statuses (CSV)', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({ status: 'inbox,in_progress' });
      expect(mockQueryAll).toHaveBeenCalledWith(expect.stringContaining('AND t.status IN (?,?)'), [
        'inbox',
        'in_progress',
      ]);
    });

    it('filters by businessId', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({ businessId: 'biz-123' });
      expect(mockQueryAll).toHaveBeenCalledWith(expect.stringContaining('AND t.business_id = ?'), [
        'biz-123',
      ]);
    });

    it('filters by workspaceId', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({ workspaceId: 'ws-123' });
      expect(mockQueryAll).toHaveBeenCalledWith(expect.stringContaining('AND t.workspace_id = ?'), [
        'ws-123',
      ]);
    });

    it('filters by assignedAgentId', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({ assignedAgentId: 'agent-123' });
      expect(mockQueryAll).toHaveBeenCalledWith(
        expect.stringContaining('AND t.assigned_agent_id = ?'),
        ['agent-123'],
      );
    });

    it('orders by created_at DESC', () => {
      mockQueryAll.mockReturnValue([]);
      listTasks({});
      expect(mockQueryAll).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY t.created_at DESC'),
        expect.any(Array),
      );
    });
  });

  describe('getTaskById', () => {
    it('returns task when found', () => {
      mockQueryOne.mockReturnValue({ id: '1', title: 'Test' } as unknown as Task);
      const result = getTaskById('1');
      expect(result).toEqual({ id: '1', title: 'Test' });
    });

    it('throws TaskNotFoundError when not found', () => {
      mockQueryOne.mockReturnValue(null);
      expect(() => getTaskById('nonexistent')).toThrow(TaskNotFoundError);
    });
  });

  describe('createTask', () => {
    it('creates task and returns it', () => {
      mockQueryOne.mockReturnValue({ name: 'Agent' });
      createTask({
        title: 'New Task',
        status: 'inbox',
        priority: 'normal',
        workspace_id: 'ws-1',
        business_id: 'biz-1',
      });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tasks'),
        expect.any(Array),
      );
    });

    it('creates task_created event', () => {
      mockQueryOne.mockReturnValue({ name: 'Agent' });
      createTask({
        title: 'New Task',
        status: 'inbox',
        priority: 'normal',
        workspace_id: 'ws-1',
        business_id: 'biz-1',
        created_by_agent_id: 'agent-1',
      });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO events'),
        expect.any(Array),
      );
    });
  });

  describe('updateTask', () => {
    const baseTask: Task = {
      id: '1',
      title: 'Original',
      status: 'inbox',
      priority: 'normal',
      assigned_agent_id: null,
      created_by_agent_id: null,
      workspace_id: 'ws-1',
      business_id: 'biz-1',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };

    it('updates task fields', () => {
      mockQueryOne.mockReturnValue(baseTask);
      updateTask('1', { title: 'New Title' });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE tasks'),
        expect.any(Array),
      );
    });

    it('throws TaskNotFoundError when not found', () => {
      mockQueryOne.mockReturnValue(null);
      expect(() => updateTask('nonexistent', { title: 'New' })).toThrow(TaskNotFoundError);
    });

    it('throws TaskNoUpdatesError when no changes', () => {
      mockQueryOne.mockReturnValue(baseTask);
      expect(() => updateTask('1', {})).toThrow(TaskNoUpdatesError);
    });

    it('throws TaskForbiddenError when non-master approves from review', () => {
      const reviewTask: Task = { ...baseTask, status: 'review' };
      mockQueryOne.mockReturnValueOnce(reviewTask).mockReturnValueOnce({ is_master: false });
      expect(() => updateTask('1', { status: 'done', updated_by_agent_id: 'agent-1' })).toThrow(
        TaskForbiddenError,
      );
    });

    it('allows master to approve from review', () => {
      const reviewTask: Task = { ...baseTask, status: 'review' };
      mockQueryOne
        .mockReturnValueOnce(reviewTask)
        .mockReturnValueOnce({ is_master: true })
        .mockReturnValueOnce(null);
      updateTask('1', { status: 'done', updated_by_agent_id: 'master' });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE tasks'),
        expect.any(Array),
      );
    });

    it('creates status change event', () => {
      mockQueryOne.mockReturnValue(baseTask);
      updateTask('1', { status: 'in_progress' });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO events'),
        expect.any(Array),
      );
    });

    it('sets shouldDispatch when status becomes assigned with agent', () => {
      const assignedTask: Task = { ...baseTask, assigned_agent_id: 'agent-1' };
      mockQueryOne.mockReturnValue(assignedTask);
      const result = updateTask('1', { status: 'assigned' });
      expect(result.shouldDispatch).toBe(true);
    });

    it('sets shouldAutoTest when status becomes testing', () => {
      mockQueryOne.mockReturnValue(baseTask);
      const result = updateTask('1', { status: 'testing' });
      expect(result.shouldAutoTest).toBe(true);
    });

    it('creates assignment event', () => {
      mockQueryOne.mockReturnValueOnce(baseTask).mockReturnValueOnce({ name: 'Agent' });
      updateTask('1', { assigned_agent_id: 'agent-1' });
      expect(mockRun).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO events'),
        expect.any(Array),
      );
    });

    it('returns updated task', () => {
      const updated: Task = { ...baseTask, title: 'New' };
      mockQueryOne.mockReturnValueOnce(baseTask).mockReturnValue(updated);
      const result = updateTask('1', { title: 'New' });
      expect(result.task).toEqual(updated);
      expect(result.previousTitle).toBe('Original');
    });
  });

  describe('deleteTask', () => {
    const baseTask: Task = {
      id: '1',
      title: 'ToDelete',
      status: 'inbox',
      priority: 'normal',
      assigned_agent_id: null,
      created_by_agent_id: null,
      workspace_id: 'ws-1',
      business_id: 'biz-1',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };

    it('throws TaskNotFoundError when not found', () => {
      mockQueryOne.mockReturnValue(null);
      expect(() => deleteTask('nonexistent')).toThrow(TaskNotFoundError);
    });

    it('deletes related records', () => {
      mockQueryOne.mockReturnValue(baseTask);
      deleteTask('1');
      expect(mockRun).toHaveBeenCalledWith('DELETE FROM openclaw_sessions WHERE task_id = ?', [
        '1',
      ]);
      expect(mockRun).toHaveBeenCalledWith('DELETE FROM events WHERE task_id = ?', ['1']);
      expect(mockRun).toHaveBeenCalledWith(
        'UPDATE conversations SET task_id = NULL WHERE task_id = ?',
        ['1'],
      );
      expect(mockRun).toHaveBeenCalledWith('DELETE FROM tasks WHERE id = ?', ['1']);
    });
  });

  describe('error classes', () => {
    it('TaskNotFoundError has correct properties', () => {
      const error = new TaskNotFoundError('Custom');
      expect(error.name).toBe('TaskNotFoundError');
      expect(error.message).toBe('Custom');
    });

    it('TaskForbiddenError has correct properties', () => {
      const error = new TaskForbiddenError('Denied');
      expect(error.name).toBe('TaskForbiddenError');
      expect(error.message).toBe('Denied');
    });

    it('TaskNoUpdatesError has correct properties', () => {
      const error = new TaskNoUpdatesError('No changes');
      expect(error.name).toBe('TaskNoUpdatesError');
      expect(error.message).toBe('No changes');
    });
  });
});
