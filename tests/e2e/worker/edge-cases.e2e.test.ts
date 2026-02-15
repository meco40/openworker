// ─── E2E Tests: Edge Cases ───────────────────────────────────
// Tests for edge cases, error scenarios, and boundary conditions

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

// ─── Test Setup ──────────────────────────────────────────────

describe('Worker E2E: Edge Cases', () => {
  let repo: SqliteWorkerRepository;

  beforeAll(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
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
      title: 'Edge Case Task',
      objective: 'Test edge case',
      originPlatform: 'Web' as never,
      originConversation: 'conv-edge',
      workspaceType: 'general',
      ...overrides,
    });
  }

  // ─── Empty/Null Handling ───────────────────────────────────

  describe('Empty/Null Handling', () => {
    it('should handle task with empty objective', async () => {
      // Arrange & Act
      const task = createTestTask({ objective: '' });

      // Assert
      expect(task.objective).toBe('');
      expect(task.id).toBeTruthy();
    });

    it('should handle task with very long objective', async () => {
      // Arrange
      const longObjective = 'A'.repeat(10000);

      // Act
      const task = createTestTask({ objective: longObjective });

      // Assert
      expect(task.objective).toBe(longObjective);
    });

    it('should handle task with special characters in title', async () => {
      // Arrange
      const specialTitle = 'Task with <script>alert("xss")</script> & "quotes"';

      // Act
      const task = createTestTask({ title: specialTitle });

      // Assert
      expect(task.title).toBe(specialTitle);
    });

    it('should handle task with unicode characters', async () => {
      // Arrange
      const unicodeTitle = 'Task with 中文 🎉 émojis';

      // Act
      const task = createTestTask({ title: unicodeTitle });

      // Assert
      expect(task.title).toBe(unicodeTitle);
    });
  });

  // ─── Checkpoint Edge Cases ─────────────────────────────────

  describe('Checkpoint Edge Cases', () => {
    it('should handle corrupted checkpoint JSON gracefully', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, 'not valid json {' as unknown as Record<string, unknown>);

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should handle checkpoint with null data', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, null as unknown as Record<string, unknown>);

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should handle checkpoint with undefined step index', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { phase: 'executing' });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should handle checkpoint with negative step index', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: -5 });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert - negative index is returned as-is (phase logic handles it)
      expect(startStepIndex).toBe(-5);
    });

    it('should handle checkpoint with very large step index', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: 999999 });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(999999);
    });

    it('should handle checkpoint with non-numeric step index', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, {
        phase: 'executing',
        stepIndex: 'invalid' as unknown as number,
      });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert
      expect(startStepIndex).toBe(0);
    });

    it('should handle checkpoint with wrong phase', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveCheckpoint(task.id, { phase: 'planning', stepIndex: 5 });

      // Act
      const updatedTask = repo.getTask(task.id)!;
      const { startStepIndex } = checkpointPhase.recoverFromCheckpoint(updatedTask);

      // Assert - only 'executing' phase resumes
      expect(startStepIndex).toBe(0);
    });
  });

  // ─── Workspace Edge Cases ──────────────────────────────────

  describe('Workspace Edge Cases', () => {
    it('should handle all workspace types', async () => {
      const workspaceTypes = ['general', 'webapp', 'research', 'creative', 'data'] as const;

      for (const type of workspaceTypes) {
        // Act
        const { workspacePath, workspaceType } = workspacePhase.setupWorkspace(
          `task-${type}`,
          type,
        );

        // Assert
        expect(workspaceType).toBe(type);
        expect(workspacePath).toContain(`task-${type}`);
      }
    });

    it('should handle workspace path with special characters', async () => {
      // Arrange - use a task ID that might cause path issues
      const taskId = 'task-with-special-chars_123.456';

      // Act
      const { workspacePath } = workspacePhase.setupWorkspace(taskId, 'general');

      // Assert
      expect(workspacePath).toContain(taskId);
    });

    it('should reuse existing workspace without error', async () => {
      // Arrange
      const taskId = 'reuse-test-task';
      const { workspacePath: path1 } = workspacePhase.setupWorkspace(taskId, 'general');

      // Act - call multiple times
      const { workspacePath: path2 } = workspacePhase.setupWorkspace(taskId, 'general');
      const { workspacePath: path3 } = workspacePhase.setupWorkspace(taskId, 'general');

      // Assert
      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });
  });

  // ─── Status Transition Edge Cases ──────────────────────────

  describe('Status Transition Edge Cases', () => {
    it('should handle all valid status transitions', async () => {
      // Arrange
      const task = createTestTask();
      const statuses: WorkerTaskStatus[] = [
        'planning',
        'executing',
        'testing',
        'review',
        'completed',
      ];

      // Act & Assert
      for (const status of statuses) {
        repo.updateStatus(task.id, status);
        const updated = repo.getTask(task.id)!;
        expect(updated.status).toBe(status);
      }
    });

    it('should handle failed status with error message', async () => {
      // Arrange
      const task = createTestTask();
      const errorMsg = 'Critical failure occurred';

      // Act
      repo.updateStatus(task.id, 'failed', { error: errorMsg });

      // Assert
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('failed');
      expect(updated.errorMessage).toBe(errorMsg);
    });

    it('should handle completed status with summary', async () => {
      // Arrange
      const task = createTestTask();
      const summary = 'Task completed successfully with all objectives met';

      // Act
      repo.updateStatus(task.id, 'completed', { summary });

      // Assert
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('completed');
      expect(updated.resultSummary).toBe(summary);
    });

    it('should handle cancelled status', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.cancelTask(task.id);

      // Assert
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('cancelled');
    });

    it('should handle interrupted status', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.markInterrupted(task.id);

      // Assert
      const updated = repo.getTask(task.id)!;
      expect(updated.status).toBe('interrupted');
      expect(updated.resumable).toBe(true);
    });
  });

  // ─── Artifact Edge Cases ───────────────────────────────────

  describe('Artifact Edge Cases', () => {
    it('should handle artifact with empty content', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      const artifact = repo.saveArtifact({
        taskId: task.id,
        name: 'empty.txt',
        type: 'file',
        content: '',
        mimeType: 'text/plain',
      });

      // Assert
      expect(artifact.content).toBe('');
      expect(artifact.name).toBe('empty.txt');
    });

    it('should handle artifact with binary-like content', async () => {
      // Arrange
      const task = createTestTask();
      const binaryContent = '\x00\x01\x02\x03\xff\xfe';

      // Act
      const artifact = repo.saveArtifact({
        taskId: task.id,
        name: 'data.bin',
        type: 'data',
        content: binaryContent,
        mimeType: 'application/octet-stream',
      });

      // Assert
      expect(artifact.content).toBe(binaryContent);
    });

    it('should handle artifact with very long content', async () => {
      // Arrange
      const task = createTestTask();
      const longContent = 'A'.repeat(100000);

      // Act
      const artifact = repo.saveArtifact({
        taskId: task.id,
        name: 'large.txt',
        type: 'file',
        content: longContent,
        mimeType: 'text/plain',
      });

      // Assert
      expect(artifact.content.length).toBe(100000);
    });

    it('should handle multiple artifacts for same task', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      for (let i = 0; i < 20; i++) {
        repo.saveArtifact({
          taskId: task.id,
          name: `file_${i}.txt`,
          type: 'file',
          content: `Content ${i}`,
          mimeType: 'text/plain',
        });
      }

      // Assert
      const artifacts = repo.getArtifacts(task.id);
      expect(artifacts).toHaveLength(20);
    });
  });

  // ─── Activity Log Edge Cases ───────────────────────────────

  describe('Activity Log Edge Cases', () => {
    it('should handle activity with very long message', async () => {
      // Arrange
      const task = createTestTask();
      const longMessage = 'A'.repeat(5000);

      // Act
      const activity = repo.addActivity({
        taskId: task.id,
        type: 'note',
        message: longMessage,
      });

      // Assert
      expect(activity.message).toBe(longMessage);
    });

    it('should handle activity with complex metadata', async () => {
      // Arrange
      const task = createTestTask();
      const complexMetadata = {
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' },
        },
        timestamp: new Date().toISOString(),
      };

      // Act
      const activity = repo.addActivity({
        taskId: task.id,
        type: 'note',
        message: 'Complex metadata test',
        metadata: complexMetadata,
      });

      // Assert
      expect(activity.metadata).not.toBeNull();
      const parsed = JSON.parse(activity.metadata!);
      expect(parsed.nested.array).toEqual([1, 2, 3]);
    });

    it('should handle many activities for same task', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      for (let i = 0; i < 50; i++) {
        repo.addActivity({
          taskId: task.id,
          type: 'note',
          message: `Activity ${i}`,
        });
      }

      // Assert
      const activities = repo.getActivities(task.id);
      expect(activities).toHaveLength(50);
    });

    it('should respect activity limit parameter', async () => {
      // Arrange
      const task = createTestTask();
      for (let i = 0; i < 50; i++) {
        repo.addActivity({
          taskId: task.id,
          type: 'note',
          message: `Activity ${i}`,
        });
      }

      // Act
      const activities = repo.getActivities(task.id, 10);

      // Assert
      expect(activities).toHaveLength(10);
    });
  });

  // ─── Step Edge Cases ───────────────────────────────────────

  describe('Step Edge Cases', () => {
    it('should handle step with empty description', async () => {
      // Arrange
      const task = createTestTask();

      // Act
      repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 0, description: '' }]);

      // Assert
      const steps = repo.getSteps(task.id);
      expect(steps[0].description).toBe('');
    });

    it('should handle step with very long description', async () => {
      // Arrange
      const task = createTestTask();
      const longDescription = 'A'.repeat(5000);

      // Act
      repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 0, description: longDescription }]);

      // Assert
      const steps = repo.getSteps(task.id);
      expect(steps[0].description.length).toBe(5000);
    });

    it('should handle many steps for same task', async () => {
      // Arrange
      const task = createTestTask();
      const stepsInput = Array.from({ length: 50 }, (_, i) => ({
        taskId: task.id,
        stepIndex: i,
        description: `Step ${i}`,
      }));

      // Act
      repo.saveSteps(task.id, stepsInput);

      // Assert
      const steps = repo.getSteps(task.id);
      expect(steps).toHaveLength(50);
      expect(steps[49].stepIndex).toBe(49);
    });
  });

  // ─── Concurrent Task Handling ──────────────────────────────

  describe('Concurrent Task Handling', () => {
    it('should handle multiple tasks independently', async () => {
      // Arrange
      const tasks = Array.from({ length: 10 }, (_, i) => createTestTask({ title: `Task ${i}` }));

      // Act & Assert
      for (const task of tasks) {
        repo.updateStatus(task.id, 'completed');
        const updated = repo.getTask(task.id)!;
        expect(updated.status).toBe('completed');
      }
    });

    it('should isolate task workspaces', async () => {
      // Arrange
      const task1 = createTestTask({ title: 'Task 1' });
      const task2 = createTestTask({ title: 'Task 2' });

      // Act
      const { workspacePath: path1 } = workspacePhase.setupWorkspace(task1.id, 'general');
      const { workspacePath: path2 } = workspacePhase.setupWorkspace(task2.id, 'general');

      // Assert
      expect(path1).not.toBe(path2);
    });
  });

  // ─── Database Constraint Tests ─────────────────────────────

  describe('Database Constraint Tests', () => {
    it('should handle tasks with same title', async () => {
      // Arrange & Act
      const task1 = createTestTask({ title: 'Same Title' });
      const task2 = createTestTask({ title: 'Same Title' });
      const task3 = createTestTask({ title: 'Same Title' });

      // Assert
      expect(task1.id).not.toBe(task2.id);
      expect(task2.id).not.toBe(task3.id);
      expect(task1.title).toBe(task2.title);
    });

    it('should enforce unique step IDs', async () => {
      // Arrange
      const task = createTestTask();
      repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 0, description: 'Step 1' }]);

      // Act - save another step
      repo.saveSteps(task.id, [{ taskId: task.id, stepIndex: 1, description: 'Step 2' }]);

      // Assert
      const steps = repo.getSteps(task.id);
      expect(steps).toHaveLength(2);
      expect(steps[0].id).not.toBe(steps[1].id);
    });
  });
});
