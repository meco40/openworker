import { describe, expect, it } from 'vitest';
import { getRunnableNodeIds } from '../../../src/server/worker/orchestraScheduler';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

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

describe('orchestra scheduler', () => {
  it('selects runnable nodes by dependency completion', () => {
    const runnable = getRunnableNodeIds(graph, {
      n1: 'completed',
      n2: 'pending',
      n3: 'pending',
    });
    expect(runnable).toEqual(['n2']);

    const runnableAfterBoth = getRunnableNodeIds(graph, {
      n1: 'completed',
      n2: 'completed',
      n3: 'pending',
    });
    expect(runnableAfterBoth).toEqual(['n3']);
  });

  it('returns independent nodes together for parallel scheduling', () => {
    const runnable = getRunnableNodeIds(graph, {
      n1: 'pending',
      n2: 'pending',
      n3: 'pending',
    });
    expect(runnable.sort()).toEqual(['n1', 'n2']);
  });
});
