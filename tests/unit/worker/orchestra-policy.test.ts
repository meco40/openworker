import { describe, expect, it } from 'vitest';
import {
  canEditOrchestra,
  canPublishOrchestra,
  enforceOrchestraGraphLimits,
} from '../../../src/server/worker/orchestraPolicy';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

function makeGraph(nodeCount: number, edgeCount: number): OrchestraFlowGraph {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index + 1}`,
    personaId: `persona-${index + 1}`,
  }));

  const edges = Array.from({ length: edgeCount }, (_, index) => {
    const from = `n${Math.max(1, (index % nodeCount) + 1)}`;
    const to = `n${Math.max(1, ((index + 1) % nodeCount) + 1)}`;
    return { from, to };
  });

  return {
    startNodeId: 'n1',
    nodes,
    edges,
  };
}

describe('orchestra policy', () => {
  it('allows only admin/dev roles for edit and publish', () => {
    expect(canEditOrchestra('admin')).toBe(true);
    expect(canEditOrchestra('dev')).toBe(true);
    expect(canEditOrchestra('viewer')).toBe(false);

    expect(canPublishOrchestra('admin')).toBe(true);
    expect(canPublishOrchestra('dev')).toBe(true);
    expect(canPublishOrchestra('member')).toBe(false);
  });

  it('enforces node and edge limits', () => {
    const ok = enforceOrchestraGraphLimits(makeGraph(5, 4), { maxNodes: 10, maxEdges: 20 });
    expect(ok.ok).toBe(true);

    const tooManyNodes = enforceOrchestraGraphLimits(makeGraph(11, 2), {
      maxNodes: 10,
      maxEdges: 20,
    });
    expect(tooManyNodes.ok).toBe(false);
    if (!tooManyNodes.ok) {
      expect(tooManyNodes.error.toLowerCase()).toContain('node');
    }

    const tooManyEdges = enforceOrchestraGraphLimits(makeGraph(5, 25), {
      maxNodes: 10,
      maxEdges: 20,
    });
    expect(tooManyEdges.ok).toBe(false);
    if (!tooManyEdges.ok) {
      expect(tooManyEdges.error.toLowerCase()).toContain('edge');
    }
  });
});
