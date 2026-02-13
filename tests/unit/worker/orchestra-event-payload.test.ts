import { describe, expect, it } from 'vitest';
import { buildWorkerWorkflowPayload } from '../../../src/server/worker/orchestraWorkflow';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

describe('orchestra workflow event payload', () => {
  it('builds workflow payload with node statuses and current node', () => {
    const graph: OrchestraFlowGraph = {
      startNodeId: 'n1',
      nodes: [
        { id: 'n1', personaId: 'persona-a' },
        { id: 'n2', personaId: 'persona-b' },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };

    const payload = buildWorkerWorkflowPayload({
      taskId: 'task-1',
      runId: 'run-1',
      flowPublishedId: 'flow-1',
      graph,
      nodeStatuses: {
        n1: 'completed',
        n2: 'running',
      },
      timestamp: '2026-02-13T12:00:00.000Z',
    });

    expect(payload.taskId).toBe('task-1');
    expect(payload.nodes.find((node) => node.id === 'n1')?.status).toBe('completed');
    expect(payload.nodes.find((node) => node.id === 'n2')?.status).toBe('running');
    expect(payload.currentNodeId).toBe('n2');
    expect(payload.edges).toHaveLength(1);
    expect(payload.timestamp).toBe('2026-02-13T12:00:00.000Z');
  });
});
