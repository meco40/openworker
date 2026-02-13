import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';

describe('WorkerRepository — Planning', () => {
  let repo: SqliteWorkerRepository;

  beforeEach(() => {
    repo = new SqliteWorkerRepository(':memory:');
  });

  const makeTask = (overrides?: Partial<Parameters<SqliteWorkerRepository['createTask']>[0]>) =>
    repo.createTask({
      title: 'Test Task',
      objective: 'Build a web app',
      originPlatform: 'Telegram' as never,
      originConversation: 'conv-1',
      ...overrides,
    });

  // ─── Planning Mode Task Creation ───────────────────────────

  describe('planning mode creation', () => {
    it('creates a task with inbox status when usePlanning is true', () => {
      const task = repo.createTask({
        title: 'Planning Task',
        objective: 'Research AI trends',
        originPlatform: 'WebChat' as never,
        originConversation: 'conv-1',
        usePlanning: true,
      });
      expect(task.status).toBe('inbox');
      expect(task.planningComplete).toBe(false);
      expect(task.planningMessages).toBeNull();
    });

    it('creates a task with queued status when usePlanning is false', () => {
      const task = repo.createTask({
        title: 'Normal Task',
        objective: 'Do something',
        originPlatform: 'WebChat' as never,
        originConversation: 'conv-1',
        usePlanning: false,
      });
      expect(task.status).toBe('queued');
    });

    it('creates a task with queued status when usePlanning is undefined', () => {
      const task = makeTask();
      expect(task.status).toBe('queued');
    });
  });

  // ─── Planning Messages CRUD ────────────────────────────────

  describe('planning messages', () => {
    it('returns empty array for task with no planning messages', () => {
      const task = makeTask();
      const messages = repo.getPlanningMessages(task.id);
      expect(messages).toEqual([]);
    });

    it('saves and retrieves planning messages', () => {
      const task = makeTask();
      const messages = [
        { role: 'system' as const, content: 'You are a planner' },
        { role: 'user' as const, content: 'Build a todo app' },
        { role: 'assistant' as const, content: 'What framework?' },
      ];

      repo.savePlanningMessages(task.id, messages);
      const retrieved = repo.getPlanningMessages(task.id);

      expect(retrieved).toHaveLength(3);
      expect(retrieved[0].role).toBe('system');
      expect(retrieved[1].content).toBe('Build a todo app');
      expect(retrieved[2].role).toBe('assistant');
    });

    it('overwrites previous messages on save', () => {
      const task = makeTask();

      repo.savePlanningMessages(task.id, [{ role: 'system', content: 'v1' }]);

      repo.savePlanningMessages(task.id, [
        { role: 'system', content: 'v1' },
        { role: 'user', content: 'v2' },
      ]);

      const retrieved = repo.getPlanningMessages(task.id);
      expect(retrieved).toHaveLength(2);
      expect(retrieved[1].content).toBe('v2');
    });

    it('returns empty array for non-existent task', () => {
      const messages = repo.getPlanningMessages('nonexistent');
      expect(messages).toEqual([]);
    });
  });

  // ─── Complete Planning ─────────────────────────────────────

  describe('completePlanning', () => {
    it('marks planning as complete', () => {
      const task = makeTask({ usePlanning: true });
      expect(task.planningComplete).toBe(false);

      repo.completePlanning(task.id);
      const updated = repo.getTask(task.id)!;
      expect(updated.planningComplete).toBe(true);
    });

    it('task retains planningMessages after completing', () => {
      const task = makeTask({ usePlanning: true });
      const messages = [
        { role: 'user' as const, content: 'My task' },
        { role: 'assistant' as const, content: 'OK' },
      ];

      repo.savePlanningMessages(task.id, messages);
      repo.completePlanning(task.id);

      const updated = repo.getTask(task.id)!;
      expect(updated.planningComplete).toBe(true);
      expect(updated.planningMessages).not.toBeNull();

      const retrieved = repo.getPlanningMessages(task.id);
      expect(retrieved).toHaveLength(2);
    });
  });
});
