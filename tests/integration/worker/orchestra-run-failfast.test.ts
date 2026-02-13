import { describe, expect, it } from 'vitest';
import { runOrchestraFlow } from '../../../src/server/worker/orchestraRunner';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

describe('orchestra run fail-fast', () => {
  it('fails fast on first node failure without retries and keeps flow version pin', async () => {
    const graph: OrchestraFlowGraph = {
      startNodeId: 'n1',
      nodes: [
        { id: 'n1', personaId: 'persona-a' },
        { id: 'n2', personaId: 'persona-b' },
        { id: 'n3', personaId: 'persona-c' },
      ],
      edges: [
        { from: 'n1', to: 'n3' },
        { from: 'n2', to: 'n3' },
      ],
    };

    const calls: Record<string, number> = {};

    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-pub-v1',
      graph,
      executeNode: async (nodeId) => {
        calls[nodeId] = (calls[nodeId] || 0) + 1;
        if (nodeId === 'n1') {
          throw new Error('node n1 failed');
        }
        return { summary: `ok-${nodeId}` };
      },
    });

    expect(result.status).toBe('failed');
    expect(result.flowPublishedId).toBe('flow-pub-v1');
    expect(result.nodes.n1.status).toBe('failed');
    expect(result.nodes.n3.status).toBe('skipped');
    expect(calls.n1).toBe(1);
    expect(calls.n2).toBe(1);
    expect(calls.n3 ?? 0).toBe(0);
  });
});
