import { describe, it, expect } from 'vitest';
import {
  orchestraGraphToReactFlow,
  reactFlowToOrchestraGraph,
  type PersonaInfo,
} from '../src/shared/lib/orchestra-graph-converter';
import type { OrchestraFlowGraph } from '../src/server/worker/orchestraGraph';

const personas: PersonaInfo[] = [
  { id: 'p-master', name: 'Master', emoji: '👑' },
  { id: 'p-research', name: 'Research', emoji: '🔬' },
  { id: 'p-review', name: 'Review', emoji: '✅' },
];

function makeGraph(overrides?: Partial<OrchestraFlowGraph>): OrchestraFlowGraph {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'p-research', position: { x: 200, y: 100 } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    ...overrides,
  };
}

describe('orchestraGraphToReactFlow', () => {
  it('converts nodes with persona enrichment', () => {
    const { nodes } = orchestraGraphToReactFlow(makeGraph(), personas);
    expect(nodes).toHaveLength(2);

    const masterNode = nodes.find((n) => n.id === 'n1')!;
    expect(masterNode.type).toBe('persona');
    expect(masterNode.position).toEqual({ x: 0, y: 0 });
    expect(masterNode.data.personaId).toBe('p-master');
    expect(masterNode.data.personaName).toBe('Master');
    expect(masterNode.data.personaEmoji).toBe('👑');
    expect(masterNode.data.isStartNode).toBe(true);
  });

  it('marks only the start node as start', () => {
    const { nodes } = orchestraGraphToReactFlow(makeGraph(), personas);
    const startNodes = nodes.filter((n) => n.data.isStartNode);
    expect(startNodes).toHaveLength(1);
    expect(startNodes[0].id).toBe('n1');
  });

  it('falls back to first node if startNodeId is missing', () => {
    const graph = makeGraph({ startNodeId: undefined });
    const { nodes } = orchestraGraphToReactFlow(graph, personas);
    expect(nodes[0].data.isStartNode).toBe(true);
  });

  it('converts edges with correct source/target', () => {
    const { edges } = orchestraGraphToReactFlow(makeGraph(), personas);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('e1');
    expect(edges[0].source).toBe('n1');
    expect(edges[0].target).toBe('n2');
    expect(edges[0].type).toBe('default');
  });

  it('uses condition edge type for labeled edges', () => {
    const graph = makeGraph({
      edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'success' }],
    });
    const { edges } = orchestraGraphToReactFlow(graph, personas);
    expect(edges[0].type).toBe('condition');
    expect(edges[0].label).toBe('success');
  });

  it('preserves skillIds on node data', () => {
    const graph = makeGraph({
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 }, skillIds: ['sk1', 'sk2'] },
        { id: 'n2', personaId: 'p-research', position: { x: 200, y: 100 } },
      ],
    });
    const { nodes } = orchestraGraphToReactFlow(graph, personas);
    expect(nodes[0].data.skillIds).toEqual(['sk1', 'sk2']);
    expect(nodes[1].data.skillIds).toEqual([]);
  });

  it('preserves routing config on node data', () => {
    const graph = makeGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          routing: { mode: 'llm', allowedNextNodeIds: ['n2'] },
        },
        { id: 'n2', personaId: 'p-research', position: { x: 200, y: 100 } },
      ],
    });
    const { nodes } = orchestraGraphToReactFlow(graph, personas);
    expect(nodes[0].data.routing).toEqual({ mode: 'llm', allowedNextNodeIds: ['n2'] });
  });

  it('uses fallback name/emoji for unknown personas', () => {
    const graph = makeGraph({
      nodes: [{ id: 'n1', personaId: 'unknown', position: { x: 0, y: 0 } }],
      edges: [],
    });
    const { nodes } = orchestraGraphToReactFlow(graph, []);
    expect(nodes[0].data.personaName).toBe('unknown');
    expect(nodes[0].data.personaEmoji).toBe('🤖');
  });
});

describe('reactFlowToOrchestraGraph', () => {
  it('round-trips a simple graph', () => {
    const original = makeGraph();
    const { nodes, edges } = orchestraGraphToReactFlow(original, personas);
    const converted = reactFlowToOrchestraGraph(nodes, edges);

    expect(converted.startNodeId).toBe('n1');
    expect(converted.nodes).toHaveLength(2);
    expect(converted.edges).toHaveLength(1);

    const masterNode = converted.nodes.find((n) => n.id === 'n1')!;
    expect(masterNode.personaId).toBe('p-master');
    expect(masterNode.position).toEqual({ x: 0, y: 0 });
  });

  it('preserves edge handles', () => {
    const graph = makeGraph({
      edges: [{ id: 'e1', from: 'n1', to: 'n2', sourceHandle: 'bottom', targetHandle: 'top' }],
    });
    const { nodes, edges } = orchestraGraphToReactFlow(graph, personas);
    const converted = reactFlowToOrchestraGraph(nodes, edges);
    expect(converted.edges[0].sourceHandle).toBe('bottom');
    expect(converted.edges[0].targetHandle).toBe('top');
  });

  it('omits skillIds/routing when empty, preserves label if enriched', () => {
    const graph = makeGraph();
    const { nodes, edges } = orchestraGraphToReactFlow(graph, personas);
    const converted = reactFlowToOrchestraGraph(nodes, edges);
    const node = converted.nodes[0];
    // Label is enriched from persona name during toReactFlow, so it round-trips
    expect(node.label).toBe('Master');
    expect(node.skillIds).toBeUndefined();
    expect(node.routing).toBeUndefined();
  });

  it('preserves label and skillIds when present', () => {
    const graph = makeGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          label: 'Coordinator',
          skillIds: ['sk1'],
        },
        { id: 'n2', personaId: 'p-research', position: { x: 200, y: 100 } },
      ],
    });
    const { nodes, edges } = orchestraGraphToReactFlow(graph, personas);
    const converted = reactFlowToOrchestraGraph(nodes, edges);
    expect(converted.nodes[0].label).toBe('Coordinator');
    expect(converted.nodes[0].skillIds).toEqual(['sk1']);
  });
});
