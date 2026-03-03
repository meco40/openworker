import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  triggerAutoDispatch,
  shouldTriggerAutoDispatch,
  type AutoDispatchOptions,
} from '@/lib/auto-dispatch';

describe('auto-dispatch', () => {
  const originalFetch = global.fetch;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    global.fetch = vi.fn();
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('shouldTriggerAutoDispatch', () => {
    it('returns true when status changes to in_progress with assigned agent', () => {
      expect(shouldTriggerAutoDispatch('inbox', 'in_progress', 'agent-123')).toBe(true);
    });

    it('returns false when status was already in_progress', () => {
      expect(shouldTriggerAutoDispatch('in_progress', 'in_progress', 'agent-123')).toBe(false);
    });

    it('returns false when new status is not in_progress', () => {
      expect(shouldTriggerAutoDispatch('inbox', 'assigned', 'agent-123')).toBe(false);
      expect(shouldTriggerAutoDispatch('inbox', 'done', 'agent-123')).toBe(false);
      expect(shouldTriggerAutoDispatch('inbox', 'review', 'agent-123')).toBe(false);
    });

    it('returns false when no agent is assigned', () => {
      expect(shouldTriggerAutoDispatch('inbox', 'in_progress', null)).toBe(false);
      expect(shouldTriggerAutoDispatch('inbox', 'in_progress', '')).toBe(false);
    });

    it('returns false when previous status is undefined but no agent assigned', () => {
      expect(shouldTriggerAutoDispatch(undefined, 'in_progress', null)).toBe(false);
    });

    it('returns true when previous status is undefined with assigned agent', () => {
      expect(shouldTriggerAutoDispatch(undefined, 'in_progress', 'agent-123')).toBe(true);
    });

    it('handles various previous statuses correctly', () => {
      expect(shouldTriggerAutoDispatch('done', 'in_progress', 'agent-123')).toBe(true);
      expect(shouldTriggerAutoDispatch('review', 'in_progress', 'agent-123')).toBe(true);
      expect(shouldTriggerAutoDispatch('testing', 'in_progress', 'agent-123')).toBe(true);
    });
  });

  describe('triggerAutoDispatch', () => {
    const baseOptions: AutoDispatchOptions = {
      taskId: 'task-123',
      taskTitle: 'Test Task',
      agentId: 'agent-456',
      agentName: 'Test Agent',
    };

    it('returns error when no agent ID is provided', async () => {
      const result = await triggerAutoDispatch({
        ...baseOptions,
        agentId: null,
      });

      expect(result).toEqual({
        success: false,
        error: 'No agent ID provided for dispatch',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('successfully dispatches task and returns success', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({ success: true });
      expect(global.fetch).toHaveBeenCalledWith('/api/tasks/task-123/dispatch', {
        method: 'POST',
      });
      expect(console.log).toHaveBeenCalledWith(
        '[Auto-Dispatch] Task "Test Task" auto-dispatched to Test Agent',
      );
    });

    it('handles HTTP error with error field in response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Task already dispatched' }),
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Task already dispatched',
      });
      expect(console.error).toHaveBeenCalled();
    });

    it('handles HTTP error with message field in response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Task not found' }),
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Task not found',
      });
    });

    it('handles HTTP error with warning field in response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ warning: 'Agent unavailable' }),
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Agent unavailable',
      });
    });

    it('handles HTTP error without error/message/warning fields', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Dispatch failed (HTTP 500)',
      });
    });

    it('handles malformed JSON response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Dispatch failed (HTTP 500)',
      });
    });

    it('handles network errors', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network timeout'),
      );

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Network timeout',
      });
      expect(console.error).toHaveBeenCalledWith(
        '[Auto-Dispatch] Error for task "Test Task":',
        'Network timeout',
      );
    });

    it('handles non-Error thrown values', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce('string error');

      const result = await triggerAutoDispatch(baseOptions);

      expect(result).toEqual({
        success: false,
        error: 'Unknown error',
      });
    });

    it('includes workspaceId in options but does not send it in request', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
      });

      await triggerAutoDispatch({
        ...baseOptions,
        workspaceId: 'workspace-789',
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/tasks/task-123/dispatch', {
        method: 'POST',
      });
    });
  });

  describe('integration scenarios', () => {
    const baseOptions: AutoDispatchOptions = {
      taskId: 'task-123',
      taskTitle: 'Test Task',
      agentId: 'agent-456',
      agentName: 'Test Agent',
    };

    it('handles multiple sequential dispatch attempts', async () => {
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Conflict' }),
        })
        .mockResolvedValueOnce({ ok: true });

      const result1 = await triggerAutoDispatch(baseOptions);
      expect(result1.success).toBe(false);

      const result2 = await triggerAutoDispatch(baseOptions);
      expect(result2.success).toBe(true);
    });

    it('handles different error types in sequence', async () => {
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Server error' }),
        })
        .mockResolvedValueOnce({ ok: true });

      const r1 = await triggerAutoDispatch(baseOptions);
      expect(r1.error).toBe('Network error');

      const r2 = await triggerAutoDispatch(baseOptions);
      expect(r2.error).toBe('Server error');

      const r3 = await triggerAutoDispatch(baseOptions);
      expect(r3.success).toBe(true);
    });
  });
});
