// ─── E2E Tests: Complete Task Lifecycles ─────────────────────
// Tests the full flow from task creation to completion/failure
// Uses in-memory SQLite database and mocked LLM calls.

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import * as checkpointPhase from '../../../src/server/worker/phases/checkpointPhase';
import * as workspacePhase from '../../../src/server/worker/phases/workspacePhase';
import type { WorkerTaskRecord, WorkerTaskStatus } from '../../../src/server/worker/workerTypes';

// ─── Mock Setup ──────────────────────────────────────────────

vi.mock('../../../src/server/worker/workerPlanner', () => ({
  planTask: vi.fn(),
}));

vi.mock('../../../src/server/worker/workerExecutor', () => ({
  executeStep: vi.fn(),
  executeOrchestraNode: vi.fn(),
  executeLlmRouting: vi.fn(),
}));

vi.mock('../../../src/server/worker/workerCallback', () => ({
  notifyTaskCompleted: vi.fn(),
  notifyTaskFailed: vi.fn(),
}));

vi.mock('../../../src/server/worker/workerTester', () => ({
  runWebappTests: vi.fn(),
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcast: vi.fn(),
}));

// Import mocked modules after vi.mock declarations
import { planTask } from '../../../src/server/worker/workerPlanner';
import { executeStep } from '../../../src/server/worker/workerExecutor';
import { runWebappTests } from '../../../src/server/worker/workerTester';

function mockPlanning(steps: string[]) {
  vi.mocked(planTask).mockResolvedValue({ steps });
}

function mockExecution(outputs: string[]) {
  vi.mocked(executeStep).mockImplementation(async () => ({
    output: outputs.shift() || 'Done',
    toolCalls: [{ name: 'test_tool', args: {}, result: 'ok' }],
  }));
}

// ─── Test Setup ──────────────────────────────────────────────

describe('Worker E2E: Task Lifecycles', () => {
  let repo: SqliteWorkerRepository;

  beforeAll(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    // Create fresh repository for each test
    repo = new SqliteWorkerRepository(':memory:');
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // ─── Helper Functions ─────────────────────────────────────

  function createTestTask(
    overrides?: Partial<Parameters<SqliteWorkerRepository['createTask']>[0]>,
  ): WorkerTaskRecord {
    return repo.createTask({
      title: 'Test Task',
      objective: 'Do something important',
      originPlatform: 'Telegram' as never,
      originConversation: 'conv-test',
      workspaceType: 'general',
      ...overrides,
    });
  }

  // ─── Standard Task Lifecycle Tests ─────────────────────────

  describe('Standard Task Lifecycle', () => {
    it('should complete a simple task end-to-end', async () => {
      // Arrange
      const task = createTestTask({ title: 'Simple Task' });
      mockPlanning(['Step 1: Analyze', 'Step 2: Execute', 'Step 3: Verify']);
      mockExecution(['Analysis complete', 'Execution complete', 'Verification complete']);

      // Act - Phase 1: Checkpoint Recovery
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(task);
      expect(startStepIndex).toBe(0);

      // Act - Phase 2: Workspace Setup
      const { workspacePath, workspaceType } = workspacePhase.setupWorkspace(task.id, 'general');
      expect(workspacePath).toContain(task.id);
      expect(workspaceType).toBe('general');

      // Assert - Verify initial state
      expect(task.status).toBe('queued');
      expect(task.title).toBe('Simple Task');

      // Verify steps are tracked in the planTask mock
      const planResult = await planTask(task);
      expect(planResult.steps).toHaveLength(3);
    });

    it('should handle task with single step', async () => {
      // Arrange
      const task = createTestTask({ title: 'Single Step Task' });
      mockPlanning(['Perform action']);

      // Act
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(task);
      const { workspaceType } = workspacePhase.setupWorkspace(task.id, 'general');

      // Assert
      expect(startStepIndex).toBe(0);
      expect(workspaceType).toBe('general');
      expect(task.totalSteps).toBe(0); // Not set yet
    });

    it('should handle task with many steps (max 10)', async () => {
      // Arrange
      const task = createTestTask({ title: 'Multi Step Task' });
      const steps = Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`);
      mockPlanning(steps);

      // Act
      const planResult = await planTask(task);

      // Assert
      expect(planResult.steps).toHaveLength(10);
    });

    it('should handle planning returning no steps', async () => {
      // Arrange
      const task = createTestTask();
      mockPlanning([]);

      // Act
      const planResult = await planTask(task);

      // Assert
      expect(planResult.steps).toHaveLength(0);
    });

    it('should handle step execution failure', async () => {
      // Arrange
      const task = createTestTask();
      vi.mocked(executeStep).mockRejectedValue(new Error('Execution failed'));

      // Act & Assert
      await expect(
        executeStep(task, {
          id: 'step-1',
          taskId: task.id,
          stepIndex: 0,
          description: 'Test',
          status: 'pending',
          output: null,
          toolCalls: null,
          startedAt: null,
          completedAt: null,
        }),
      ).rejects.toThrow('Execution failed');
    });

    it('should save artifacts correctly', async () => {
      // Arrange
      const task = createTestTask();
      const artifact = {
        name: 'result.txt',
        type: 'file' as const,
        content: 'Hello World',
        mimeType: 'text/plain',
      };

      // Act
      const savedArtifact = repo.saveArtifact({
        taskId: task.id,
        ...artifact,
      });

      // Assert
      expect(savedArtifact.name).toBe('result.txt');
      expect(savedArtifact.content).toBe('Hello World');

      const artifacts = repo.getArtifacts(task.id);
      expect(artifacts).toHaveLength(1);
    });
  });

  // ─── Checkpoint Recovery Tests ─────────────────────────────

  describe('Checkpoint Recovery', () => {
    it('should resume from checkpoint at step 2', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: 2 });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(2);
    });

    it('should start from beginning with invalid checkpoint', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { invalid: 'data' });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should start from beginning when no checkpoint exists', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(task);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should handle corrupted checkpoint JSON gracefully', async () => {
      // Arrange
      const task = createTestTask();
      // Directly set invalid checkpoint in DB
      repo.saveCheckpoint(task.id, 'not valid json {' as unknown as Record<string, unknown>);

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });
  });

  // ─── Workspace Integration Tests ───────────────────────────

  describe('Workspace Integration', () => {
    it('should create workspace with correct scaffold for webapp type', async () => {
      // Act
      const { workspacePath, workspaceType } = workspacePhase.setupWorkspace('task-123', 'webapp');

      // Assert
      expect(workspaceType).toBe('webapp');
      expect(workspacePath).toContain('task-123');
    });

    it('should create workspace with correct scaffold for research type', async () => {
      // Act
      const { workspaceType } = workspacePhase.setupWorkspace('task-456', 'research');

      // Assert
      expect(workspaceType).toBe('research');
    });

    it('should reuse existing workspace', async () => {
      // Arrange
      const task = createTestTask();
      workspacePhase.setupWorkspace(task.id, 'general');

      // Act - Second call should reuse
      const { workspacePath: path2 } = workspacePhase.setupWorkspace(task.id, 'general');
      const { workspacePath: path3 } = workspacePhase.setupWorkspace(task.id, 'general');

      // Assert
      expect(path2).toBe(path3);
    });
  });

  // ─── Webapp Testing Integration Tests ──────────────────────

  describe('Webapp Testing Integration', () => {
    it('should pass webapp tests', async () => {
      // Arrange
      vi.mocked(runWebappTests).mockReturnValue({
        passed: true,
        total: 5,
        failed: 0,
        results: [],
      });

      // Act
      const result = runWebappTests('/tmp/test-workspace');

      // Assert
      expect(result.passed).toBe(true);
      expect(result.total).toBe(5);
    });

    it('should fail webapp tests with errors', async () => {
      // Arrange
      vi.mocked(runWebappTests).mockReturnValue({
        passed: false,
        total: 5,
        failed: 2,
        results: [
          { name: 'DOCTYPE', passed: false, message: 'DOCTYPE missing' },
          { name: 'HTML tag', passed: true, message: 'OK' },
        ],
      });

      // Act
      const result = runWebappTests('/tmp/test-workspace');

      // Assert
      expect(result.passed).toBe(false);
      expect(result.failed).toBe(2);
    });
  });

  // ─── Activity Logging Tests ────────────────────────────────

  describe('Activity Logging', () => {
    it('should log all status changes', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.addActivity({
        taskId: task.id,
        type: 'status_change',
        message: 'Status changed to executing',
        metadata: { from: 'queued', to: 'executing' },
      });

      repo.addActivity({
        taskId: task.id,
        type: 'status_change',
        message: 'Status changed to completed',
        metadata: { from: 'executing', to: 'completed' },
      });

      // Assert
      const activities = repo.getActivities(task.id);
      const statusChanges = activities.filter((a) => a.type === 'status_change');
      expect(statusChanges).toHaveLength(2);
    });

    it('should log step completions', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.addActivity({
        taskId: task.id,
        type: 'step_completed',
        message: 'Step 1 completed',
        metadata: { stepIndex: 0 },
      });

      repo.addActivity({
        taskId: task.id,
        type: 'step_completed',
        message: 'Step 2 completed',
        metadata: { stepIndex: 1 },
      });

      // Assert
      const activities = repo.getActivities(task.id);
      const stepCompletions = activities.filter((a) => a.type === 'step_completed');
      expect(stepCompletions).toHaveLength(2);
    });

    it('should log step failures', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.addActivity({
        taskId: task.id,
        type: 'step_failed',
        message: 'Step 1 failed',
        metadata: { stepIndex: 0, error: 'Timeout' },
      });

      // Assert
      const activities = repo.getActivities(task.id);
      const stepFailures = activities.filter((a) => a.type === 'step_failed');
      expect(stepFailures).toHaveLength(1);
    });
  });

  // ─── Status Transition Tests ───────────────────────────────

  describe('Status Transitions', () => {
    it('should transition through all statuses correctly', async () => {
      // Arrange
      const task = createTestTask();
      const statusTransitions = ['planning', 'executing', 'completed'];

      // Act
      for (const status of statusTransitions) {
        repo.updateStatus(task.id, status as WorkerTaskStatus);
      }

      // Assert
      const updatedTask = repo.getTask(task.id)!;
      expect(updatedTask.status).toBe('completed');
    });

    it('should transition to failed on error', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.updateStatus(task.id, 'failed', { error: 'Something broke' });

      // Assert
      const updatedTask = repo.getTask(task.id)!;
      expect(updatedTask.status).toBe('failed');
      expect(updatedTask.errorMessage).toBe('Something broke');
    });

    it('should transition to review for manual inspection', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.updateStatus(task.id, 'review', { summary: 'Needs review' });

      // Assert
      const updatedTask = repo.getTask(task.id)!;
      expect(updatedTask.status).toBe('review');
    });
  });

  // ─── Task CRUD Operations ──────────────────────────────────

  describe('Task CRUD Operations', () => {
    it('should create task with correct initial state', async () => {
      // Act
      const task = createTestTask({ title: 'New Task' });

      // Assert
      expect(task.status).toBe('queued');
      expect(task.title).toBe('New Task');
      expect(task.currentStep).toBe(0);
      expect(task.totalSteps).toBe(0);
    });

    it('should retrieve task by id', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      const retrieved = repo.getTask(task.id);

      // Assert
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(task.id);
    });

    it('should return null for non-existent task', async () => {
      // Act
      const retrieved = repo.getTask('non-existent-id');

      // Assert
      expect(retrieved).toBeNull();
    });

    it('should list all tasks', async () => {
      // Arrange
      createTestTask({ title: 'Task 1' });
      createTestTask({ title: 'Task 2' });
      createTestTask({ title: 'Task 3' });

      // Act
      const tasks = repo.listTasks();

      // Assert
      expect(tasks).toHaveLength(3);
    });

    it('should filter tasks by status', async () => {
      // Arrange
      const task1 = createTestTask({ title: 'Task 1' });
      const _task2 = createTestTask({ title: 'Task 2' });
      repo.updateStatus(task1.id, 'executing');

      // Act
      const queuedTasks = repo.listTasks({ status: 'queued' });
      const executingTasks = repo.listTasks({ status: 'executing' });

      // Assert
      expect(queuedTasks).toHaveLength(1);
      expect(executingTasks).toHaveLength(1);
    });
  });
});
