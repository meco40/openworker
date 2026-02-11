import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkerRepository } from '../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../src/server/worker/workerTypes';

describe('SqliteWorkerRepository', () => {
  let repo: SqliteWorkerRepository;

  beforeEach(() => {
    repo = new SqliteWorkerRepository(':memory:');
  });

  const makeTask = (overrides?: Partial<Parameters<SqliteWorkerRepository['createTask']>[0]>) =>
    repo.createTask({
      title: 'Test Task',
      objective: 'Do something',
      originPlatform: 'Telegram' as never,
      originConversation: 'conv-1',
      ...overrides,
    });

  // ─── Task CRUD ──────────────────────────────────────────────

  describe('tasks', () => {
    it('creates a task with queued status', () => {
      const task = makeTask();
      expect(task.id).toMatch(/^task-/);
      expect(task.status).toBe('queued');
      expect(task.title).toBe('Test Task');
      expect(task.objective).toBe('Do something');
      expect(task.resumable).toBe(false);
    });

    it('gets task by id', () => {
      const created = makeTask();
      const found = repo.getTask(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('returns null for missing task', () => {
      expect(repo.getTask('nonexistent')).toBeNull();
    });

    it('updates status', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'executing');
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('executing');
      expect(updated.startedAt).not.toBeNull();
    });

    it('updates status with summary', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'completed', { summary: 'All done' });
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.resultSummary).toBe('All done');
      expect(updated.completedAt).not.toBeNull();
    });

    it('updates status with error', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'failed', { error: 'Something broke' });
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.errorMessage).toBe('Something broke');
    });

    it('lists all tasks', () => {
      makeTask({ title: 'A' });
      makeTask({ title: 'B' });
      const tasks = repo.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('lists tasks by status filter', () => {
      const t1 = makeTask({ title: 'A' });
      makeTask({ title: 'B' });
      repo.updateStatus(t1.id, 'executing');

      const queued = repo.listTasks({ status: 'queued' });
      expect(queued).toHaveLength(1);
      expect(queued[0].title).toBe('B');
    });

    it('cancels a task', () => {
      const task = makeTask();
      repo.cancelTask(task.id);
      expect(repo.getTask(task.id)!.status).toBe('cancelled');
    });
  });

  // ─── Queue ──────────────────────────────────────────────────

  describe('queue', () => {
    it('getNextQueuedTask returns oldest queued task (FIFO)', () => {
      const t1 = makeTask({ title: 'First' });
      makeTask({ title: 'Second' });

      const next = repo.getNextQueuedTask();
      expect(next).not.toBeNull();
      expect(next!.id).toBe(t1.id);
    });

    it('getNextQueuedTask returns null when no queued tasks', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'executing');
      expect(repo.getNextQueuedTask()).toBeNull();
    });

    it('getActiveTask returns currently executing task', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'executing');
      const active = repo.getActiveTask();
      expect(active).not.toBeNull();
      expect(active!.id).toBe(task.id);
    });

    it('getActiveTask returns null when no active tasks', () => {
      makeTask(); // queued, not active
      expect(repo.getActiveTask()).toBeNull();
    });
  });

  // ─── Checkpoint / Resume ───────────────────────────────────

  describe('checkpoint and resume', () => {
    it('marks task as interrupted with resumable flag', () => {
      const task = makeTask();
      repo.updateStatus(task.id, 'executing');
      repo.markInterrupted(task.id);
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('interrupted');
      expect(updated.resumable).toBe(true);
    });

    it('saves and loads checkpoint data', () => {
      const task = makeTask();
      repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: 3 });
      const updated = repo.getTask(task.id)!;
      expect(updated.lastCheckpoint).not.toBeNull();
      const checkpoint = JSON.parse(updated.lastCheckpoint!);
      expect(checkpoint.phase).toBe('executing');
      expect(checkpoint.stepIndex).toBe(3);
    });
  });

  // ─── Steps ──────────────────────────────────────────────────

  describe('steps', () => {
    it('saves and retrieves steps in order', () => {
      const task = makeTask();
      repo.saveSteps(task.id, [
        { taskId: task.id, stepIndex: 0, description: 'Step A' },
        { taskId: task.id, stepIndex: 1, description: 'Step B' },
        { taskId: task.id, stepIndex: 2, description: 'Step C' },
      ]);

      const steps = repo.getSteps(task.id);
      expect(steps).toHaveLength(3);
      expect(steps[0].description).toBe('Step A');
      expect(steps[2].description).toBe('Step C');

      // totalSteps should be updated
      const updated = repo.getTask(task.id)!;
      expect(updated.totalSteps).toBe(3);
    });

    it('updates step status with output', () => {
      const task = makeTask();
      repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 0, description: 'Do it' }]);
      const steps = repo.getSteps(task.id);

      repo.updateStepStatus(steps[0].id, 'completed', 'Done successfully', '["shell"]');
      const updated = repo.getSteps(task.id);
      expect(updated[0].status).toBe('completed');
      expect(updated[0].output).toBe('Done successfully');
      expect(updated[0].toolCalls).toBe('["shell"]');
    });
  });

  // ─── Artifacts ──────────────────────────────────────────────

  describe('artifacts', () => {
    it('saves and retrieves artifacts', () => {
      const task = makeTask();
      const art = repo.saveArtifact({
        taskId: task.id,
        name: 'index.html',
        type: 'code',
        content: '<html></html>',
        mimeType: 'text/html',
      });

      expect(art.id).toMatch(/^art-/);
      expect(art.name).toBe('index.html');

      const artifacts = repo.getArtifacts(task.id);
      expect(artifacts).toHaveLength(1);
    });
  });

  // ─── Approval Rules ────────────────────────────────────────

  describe('approval rules', () => {
    it('adds and checks exact command match', () => {
      repo.addApprovalRule('npm install');
      expect(repo.isCommandApproved('npm install')).toBe(true);
      expect(repo.isCommandApproved('rm -rf /')).toBe(false);
    });

    it('checks glob pattern match', () => {
      repo.addApprovalRule('npm *');
      expect(repo.isCommandApproved('npm install express')).toBe(true);
      expect(repo.isCommandApproved('npm run build')).toBe(true);
      expect(repo.isCommandApproved('pip install')).toBe(false);
    });

    it('deduplicates rules', () => {
      repo.addApprovalRule('npm install');
      repo.addApprovalRule('npm install'); // duplicate
      expect(repo.listApprovalRules()).toHaveLength(1);
    });

    it('removes rules', () => {
      repo.addApprovalRule('npm install');
      const rules = repo.listApprovalRules();
      repo.removeApprovalRule(rules[0].id);
      expect(repo.listApprovalRules()).toHaveLength(0);
      expect(repo.isCommandApproved('npm install')).toBe(false);
    });
  });
});
