import { describe, expect, it } from 'vitest';
import { validateOrchestraGraph } from '../../../src/server/worker/orchestraValidator';
import type { OrchestraFlowGraph } from '../../../src/server/worker/orchestraGraph';

function makeValidGraph(): OrchestraFlowGraph {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'persona-a', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'persona-b', position: { x: 0, y: 100 } },
      { id: 'n3', personaId: 'persona-c', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ],
  };
}

describe('orchestra graph validator', () => {
  it('accepts a valid DAG', () => {
    const result = validateOrchestraGraph(makeValidGraph(), {
      allowedPersonaIds: new Set(['persona-a', 'persona-b', 'persona-c']),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects cycles', () => {
    const graph = makeValidGraph();
    graph.edges.push({ id: 'e-cycle', from: 'n3', to: 'n1' });
    const result = validateOrchestraGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'cycle_detected')).toBe(true);
  });

  it('rejects orphan nodes', () => {
    const graph = makeValidGraph();
    graph.nodes.push({ id: 'n4', personaId: 'persona-d', position: { x: 0, y: 300 } });
    const result = validateOrchestraGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'orphan_node')).toBe(true);
  });

  it('rejects edges to unknown nodes', () => {
    const graph = makeValidGraph();
    graph.edges.push({ id: 'e-bad', from: 'n2', to: 'n-unknown' });
    const result = validateOrchestraGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'unknown_edge_node')).toBe(true);
  });

  it('rejects nodes without persona', () => {
    const graph = makeValidGraph();
    graph.nodes[1] = { id: 'n2', personaId: '', position: { x: 0, y: 100 } };
    const result = validateOrchestraGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'missing_persona')).toBe(true);
  });

  it('rejects llm routing options outside allowed edges', () => {
    const graph = makeValidGraph();
    graph.nodes[0] = {
      id: 'n1',
      personaId: 'persona-a',
      position: { x: 0, y: 0 },
      routing: {
        mode: 'llm',
        allowedNextNodeIds: ['n3'],
      },
    };
    const result = validateOrchestraGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'routing_option_not_reachable')).toBe(true);
  });

  it('rejects unauthorized persona ids', () => {
    const result = validateOrchestraGraph(makeValidGraph(), {
      allowedPersonaIds: new Set(['persona-a', 'persona-b']),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((err) => err.code === 'unauthorized_persona')).toBe(true);
  });
});
