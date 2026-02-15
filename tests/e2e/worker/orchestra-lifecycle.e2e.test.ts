// ─── E2E Tests: Orchestra Flow Lifecycles ────────────────────
// Tests the complete Orchestra flow execution from task creation
// through node execution to completion.

import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { SqliteWorkerRepository } from '../../../src/server/worker/workerRepository';
import type { WorkerTaskRecord } from '../../../src/server/worker/workerTypes';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

// ─── Mock Setup ──────────────────────────────────────────────

vi.mock('../../../src/server/worker/workerExecutor', () => ({
  executeOrchestraNode: vi.fn(),
  executeLlmRouting: vi.fn(),
}));

vi.mock('../../../src/server/worker/workerCallback', () => ({
  notifyTaskCompleted: vi.fn(),
  notifyTaskFailed: vi.fn(),
}));

vi.mock('../../../src/server/gateway/broadcast', () => ({
  broadcast: vi.fn(),
}));

// Import mocked modules after vi.mock declarations
function createLinearGraph(): OrchestraFlowGraph {
  return {
    nodes: [
      { id: 'node1', personaId: 'developer', position: { x: 0, y: 0 } },
      { id: 'node2', personaId: 'reviewer', position: { x: 200, y: 0 } },
      { id: 'node3', personaId: 'deployer', position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'edge-node1-node2', from: 'node1', to: 'node2' },
      { id: 'edge-node2-node3', from: 'node2', to: 'node3' },
    ],
  };
}

function createBranchingGraph(): OrchestraFlowGraph {
  return {
    nodes: [
      { id: 'start', personaId: 'analyzer', position: { x: 0, y: 0 } },
      { id: 'pathA', personaId: 'developer', position: { x: 200, y: -100 } },
      { id: 'pathB', personaId: 'tester', position: { x: 200, y: 100 } },
      { id: 'merge', personaId: 'reviewer', position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'edge-start-pathA', from: 'start', to: 'pathA' },
      { id: 'edge-start-pathB', from: 'start', to: 'pathB' },
      { id: 'edge-pathA-merge', from: 'pathA', to: 'merge' },
      { id: 'edge-pathB-merge', from: 'pathB', to: 'merge' },
    ],
  };
}

// ─── Test Setup ──────────────────────────────────────────────

describe('Worker E2E: Orchestra Flow Lifecycles', () => {
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
      title: 'Orchestra Test Task',
      objective: 'Execute orchestra flow',
      originPlatform: 'Web' as never,
      originConversation: 'conv-orchestra',
      workspaceType: 'general',
      ...overrides,
    });
  }

  function createPublishedFlow(name: string, graph: OrchestraFlowGraph) {
    const draft = repo.createFlowDraft({
      userId: 'user-1',
      workspaceType: 'general',
      name,
      graphJson: JSON.stringify(graph),
    });
    return repo.publishFlowDraft(draft.id, 'user-1')!;
  }

  // ─── Flow Draft and Publishing Tests ───────────────────────

  describe('Flow Draft Management', () => {
    it('should create flow draft', async () => {
      // Act
      const draft = repo.createFlowDraft({
        userId: 'user-1',
        workspaceType: 'general',
        name: 'Test Flow',
        graphJson: JSON.stringify(createLinearGraph()),
      });

      // Assert
      expect(draft.name).toBe('Test Flow');
      expect(draft.status).toBe('draft');
      expect(draft.userId).toBe('user-1');
    });

    it('should publish flow draft', async () => {
      // Arrange
      const graph = createLinearGraph();
      const draft = repo.createFlowDraft({
        userId: 'user-1',
        workspaceType: 'general',
        name: 'Test Flow',
        graphJson: JSON.stringify(graph),
      });

      // Act
      const published = repo.publishFlowDraft(draft.id, 'user-1')!;

      // Assert
      expect(published).not.toBeNull();
      expect(published.name).toBe('Test Flow');
      expect(published.version).toBe(1);
      expect(published.draftId).toBe(draft.id);
    });

    it('should increment version on multiple publishes', async () => {
      // Arrange
      const draft = repo.createFlowDraft({
        userId: 'user-1',
        workspaceType: 'general',
        name: 'Versioned Flow',
        graphJson: JSON.stringify(createLinearGraph()),
      });

      // Act
      const published1 = repo.publishFlowDraft(draft.id, 'user-1')!;

      // Create new draft with same name and publish again
      const draft2 = repo.createFlowDraft({
        userId: 'user-1',
        workspaceType: 'general',
        name: 'Versioned Flow',
        graphJson: JSON.stringify(createBranchingGraph()),
      });
      const published2 = repo.publishFlowDraft(draft2.id, 'user-1')!;

      // Assert
      expect(published1.version).toBe(1);
      expect(published2.version).toBe(2);
    });

    it('should retrieve published flow', async () => {
      // Arrange
      const graph = createLinearGraph();
      const published = createPublishedFlow('Retrievable Flow', graph);

      // Act
      const retrieved = repo.getFlowPublished(published.id, 'user-1');

      // Assert
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(published.id);
      expect(retrieved!.name).toBe('Retrievable Flow');
    });

    it('should list published flows', async () => {
      // Arrange
      createPublishedFlow('Flow 1', createLinearGraph());
      createPublishedFlow('Flow 2', createBranchingGraph());

      // Act
      const flows = repo.listPublishedFlows('user-1');

      // Assert
      expect(flows).toHaveLength(2);
    });
  });

  // ─── Run Management Tests ──────────────────────────────────

  describe('Run Management', () => {
    it('should create run record', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Test Flow', graph);
      const task = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });

      // Act
      const run = repo.createRun({
        taskId: task.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'running',
      });

      // Assert
      expect(run).not.toBeNull();
      expect(run.taskId).toBe(task.id);
      expect(run.status).toBe('running');
    });

    it('should update run status', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Test Flow', graph);
      const task = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });
      const run = repo.createRun({
        taskId: task.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'running',
      });

      // Act
      const updated = repo.updateRunStatus(run.id, { status: 'completed' });

      // Assert
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
    });

    it('should track run node status', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Test Flow', graph);
      const task = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });
      const run = repo.createRun({
        taskId: task.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'running',
      });

      // Act
      repo.upsertRunNodeStatus(run.id, 'node1', {
        personaId: 'developer',
        status: 'completed',
        outputSummary: 'Node 1 completed',
      });

      repo.upsertRunNodeStatus(run.id, 'node2', {
        personaId: 'reviewer',
        status: 'running',
      });

      // Assert
      const nodes = repo.listRunNodes(run.id);
      expect(nodes).toHaveLength(2);
      expect(nodes.find((n) => n.nodeId === 'node1')?.status).toBe('completed');
      expect(nodes.find((n) => n.nodeId === 'node2')?.status).toBe('running');
    });

    it('should update existing node status', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Test Flow', graph);
      const task = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });
      const run = repo.createRun({
        taskId: task.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'running',
      });

      // Act - Create initial status
      repo.upsertRunNodeStatus(run.id, 'node1', {
        personaId: 'developer',
        status: 'running',
      });

      // Update status
      repo.upsertRunNodeStatus(run.id, 'node1', {
        personaId: 'developer',
        status: 'completed',
        outputSummary: 'Done',
      });

      // Assert
      const nodes = repo.listRunNodes(run.id);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].status).toBe('completed');
      expect(nodes[0].outputSummary).toBe('Done');
    });
  });

  // ─── Activity Logging Tests ────────────────────────────────

  describe('Activity Logging', () => {
    it('should log Orchestra-specific activities', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Test Flow', graph);
      const task = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });

      // Act
      repo.addActivity({
        taskId: task.id,
        type: 'status_change',
        message: `Orchestra-Ausführung gestartet (${flow.name} v${flow.version})`,
        metadata: { from: 'queued', to: 'executing', flowPublishedId: flow.id },
      });

      repo.addActivity({
        taskId: task.id,
        type: 'step_completed',
        message: 'Orchestra-Node abgeschlossen: node1',
        metadata: { nodeId: 'node1', runId: 'run-1' },
      });

      // Assert
      const activities = repo.getActivities(task.id);
      expect(activities).toHaveLength(2);
      expect(activities.some((a) => a.message.includes('Orchestra'))).toBe(true);
    });
  });

  // ─── Graph Structure Tests ─────────────────────────────────

  describe('Graph Structure Validation', () => {
    it('should store and retrieve graph JSON correctly', async () => {
      // Arrange
      const graph = createLinearGraph();
      const published = createPublishedFlow('Graph Test', graph);

      // Act
      const retrieved = repo.getFlowPublished(published.id, 'user-1');
      const retrievedGraph = JSON.parse(retrieved!.graphJson) as OrchestraFlowGraph;

      // Assert
      expect(retrievedGraph.nodes).toHaveLength(3);
      expect(retrievedGraph.edges).toHaveLength(2);
      expect(retrievedGraph.nodes[0].id).toBe('node1');
    });

    it('should handle complex graph with routing', async () => {
      // Arrange
      const graph: OrchestraFlowGraph = {
        nodes: [
          {
            id: 'decision',
            personaId: 'analyzer',
            position: { x: 0, y: 0 },
            routing: {
              mode: 'llm',
              allowedNextNodeIds: ['pathA', 'pathB'],
            },
          },
          { id: 'pathA', personaId: 'developer', position: { x: 200, y: -100 } },
          { id: 'pathB', personaId: 'tester', position: { x: 200, y: 100 } },
        ],
        edges: [
          { id: 'edge-decision-pathA', from: 'decision', to: 'pathA' },
          { id: 'edge-decision-pathB', from: 'decision', to: 'pathB' },
        ],
      };

      // Act
      const published = createPublishedFlow('Routing Flow', graph);
      const retrieved = repo.getFlowPublished(published.id, 'user-1');
      const retrievedGraph = JSON.parse(retrieved!.graphJson) as OrchestraFlowGraph;

      // Assert
      expect(retrievedGraph.nodes[0].routing).toBeDefined();
      expect(retrievedGraph.nodes[0].routing!.mode).toBe('llm');
      expect(retrievedGraph.nodes[0].routing!.allowedNextNodeIds).toEqual(['pathA', 'pathB']);
    });
  });

  // ─── Task Flow Association Tests ───────────────────────────

  describe('Task Flow Association', () => {
    it('should associate task with published flow', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Associated Flow', graph);

      // Act
      const task = createTestTask({
        title: 'Task with Flow',
        flowPublishedId: flow.id,
        userId: 'user-1',
      });

      // Assert
      expect(task.flowPublishedId).toBe(flow.id);
    });

    it('should retrieve flow for task', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Retrievable Flow', graph);
      const task = createTestTask({
        flowPublishedId: flow.id,
        userId: 'user-1',
      });

      // Act
      const retrievedFlow = repo.getFlowPublished(task.flowPublishedId!, 'user-1');

      // Assert
      expect(retrievedFlow).not.toBeNull();
      expect(retrievedFlow!.id).toBe(flow.id);
    });
  });

  // ─── Metrics Tests ─────────────────────────────────────────

  describe('Orchestra Metrics', () => {
    it('should track run metrics', async () => {
      // Arrange
      const graph = createLinearGraph();
      const flow = createPublishedFlow('Metrics Flow', graph);
      const task1 = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });
      const task2 = createTestTask({ flowPublishedId: flow.id, userId: 'user-1' });

      repo.createRun({
        taskId: task1.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'completed',
      });

      repo.createRun({
        taskId: task2.id,
        userId: 'user-1',
        flowPublishedId: flow.id,
        status: 'failed',
      });

      // Act
      const metrics = repo.getOrchestraMetrics();

      // Assert
      expect(metrics.runCount).toBe(2);
      expect(metrics.failFastAbortCount).toBe(1); // One failed run
    });
  });
});
