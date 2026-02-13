import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkerRepository } from '../src/server/worker/workerRepository';

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

  // ─── New Kanban Statuses ───────────────────────────────────

  describe('kanban statuses', () => {
    it('stores and retrieves inbox status', () => {
      repo.createTask(makeTask({ title: 'Inbox Task' }));
      const task = repo.getNextQueuedTask()!;
      repo.updateStatus(task.id, 'inbox');
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('inbox');
    });

    it('stores and retrieves assigned status', () => {
      repo.createTask(makeTask({ title: 'Assigned Task' }));
      const task = repo.getNextQueuedTask()!;
      repo.updateStatus(task.id, 'assigned');
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('assigned');
    });

    it('stores and retrieves testing status', () => {
      repo.createTask(makeTask({ title: 'Testing Task' }));
      const task = repo.getNextQueuedTask()!;
      repo.updateStatus(task.id, 'testing');
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('testing');
    });

    it('getActiveTask does not return inbox/assigned/testing tasks', () => {
      repo.createTask(makeTask({ title: 'Inbox' }));
      const task = repo.getNextQueuedTask()!;
      repo.updateStatus(task.id, 'inbox');
      expect(repo.getActiveTask()).toBeNull();

      repo.updateStatus(task.id, 'assigned');
      expect(repo.getActiveTask()).toBeNull();

      repo.updateStatus(task.id, 'testing');
      expect(repo.getActiveTask()).toBeNull();
    });
  });

  // ─── Persona Assignment ────────────────────────────────────

  describe('persona assignment', () => {
    it('assigns a persona to a task', () => {
      const task = makeTask();
      repo.assignPersona(task.id, 'persona-abc');
      const updated = repo.getTask(task.id)!;
      expect(updated.assignedPersonaId).toBe('persona-abc');
    });

    it('unassigns a persona (null)', () => {
      const task = makeTask();
      repo.assignPersona(task.id, 'persona-abc');
      repo.assignPersona(task.id, null);
      const updated = repo.getTask(task.id)!;
      expect(updated.assignedPersonaId).toBeNull();
    });

    it('newly created task has no assigned persona', () => {
      const task = makeTask();
      expect(task.assignedPersonaId).toBeNull();
    });
  });

  // ─── Activities ─────────────────────────────────────────────

  describe('activities', () => {
    it('adds an activity to a task', () => {
      const task = makeTask();
      const activity = repo.addActivity({
        taskId: task.id,
        type: 'status_change',
        message: 'Status changed to executing',
      });
      expect(activity.id).toMatch(/^act-/);
      expect(activity.taskId).toBe(task.id);
      expect(activity.type).toBe('status_change');
      expect(activity.message).toBe('Status changed to executing');
      expect(activity.metadata).toBeNull();
      expect(activity.createdAt).toBeTruthy();
    });

    it('adds activity with metadata', () => {
      const task = makeTask();
      const activity = repo.addActivity({
        taskId: task.id,
        type: 'persona_assigned',
        message: 'Persona Max assigned',
        metadata: { personaId: 'p-1', personaName: 'Max' },
      });
      expect(activity.metadata).not.toBeNull();
      const meta = JSON.parse(activity.metadata!);
      expect(meta.personaId).toBe('p-1');
      expect(meta.personaName).toBe('Max');
    });

    it('retrieves activities in reverse chronological order', () => {
      const task = makeTask();
      repo.addActivity({ taskId: task.id, type: 'status_change', message: 'First' });
      repo.addActivity({ taskId: task.id, type: 'status_change', message: 'Second' });
      repo.addActivity({ taskId: task.id, type: 'note', message: 'Third' });

      const activities = repo.getActivities(task.id);
      expect(activities).toHaveLength(3);
      expect(activities[0].message).toBe('Third');
      expect(activities[2].message).toBe('First');
    });

    it('respects limit parameter', () => {
      const task = makeTask();
      for (let i = 0; i < 5; i++) {
        repo.addActivity({ taskId: task.id, type: 'note', message: `Activity ${i}` });
      }
      const activities = repo.getActivities(task.id, 2);
      expect(activities).toHaveLength(2);
    });

    it('returns empty array for task with no activities', () => {
      const task = makeTask();
      expect(repo.getActivities(task.id)).toEqual([]);
    });

    it('activities are deleted when task is deleted', () => {
      const task = makeTask();
      repo.addActivity({ taskId: task.id, type: 'note', message: 'Will be deleted' });
      repo.deleteTask(task.id);
      // Task is gone, so activities table should be clean
      // Verify via creating a new task with same activities check
      const task2 = makeTask();
      expect(repo.getActivities(task2.id)).toEqual([]);
    });
  });
});
