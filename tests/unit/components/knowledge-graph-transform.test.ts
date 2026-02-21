import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeFlowGraph,
  filterConnectedFlowSubgraph,
} from '@/components/knowledge/graph/knowledgeGraphTransform';
import type { KnowledgeGraphApiPayload } from '@/components/knowledge/graph';

const payload: KnowledgeGraphApiPayload = {
  graph: {
    nodes: [
      { id: 'n1', label: 'Atlas', category: 'project', owner: 'persona', aliasCount: 2 },
      { id: 'n2', label: 'Claude', category: 'assistant', owner: 'shared', aliasCount: 0 },
      { id: 'n3', label: 'LanceDB', category: 'tool', owner: 'user', aliasCount: 1 },
      { id: 'n4', label: 'OpenClaw', category: 'organization', owner: 'shared', aliasCount: 0 },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', relationType: 'uses', confidence: 0.9 },
      { id: 'e2', source: 'n2', target: 'n3', relationType: 'stores', confidence: 0.75 },
      { id: 'e3', source: 'n3', target: 'n4', relationType: 'part_of', confidence: 0.8 },
    ],
  },
  stats: {
    nodes: 4,
    edges: 3,
    categories: {
      project: 1,
      assistant: 1,
      tool: 1,
      organization: 1,
    },
    truncated: false,
  },
};

describe('knowledgeGraphTransform', () => {
  it('maps API graph to ReactFlow nodes/edges with deterministic positions', () => {
    const result = buildKnowledgeFlowGraph({
      payload,
      query: '',
      enabledCategories: new Set(['project', 'assistant', 'tool', 'organization']),
      maxRenderNodes: 100,
      maxRenderEdges: 100,
      currentZoom: 1,
    });

    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
    expect(result.nodes[0].position).toHaveProperty('x');
    expect(result.nodes[0].position).toHaveProperty('y');
    expect(result.nodes[0].data).toHaveProperty('driftPhase');
    expect(result.nodes[0].data).toHaveProperty('driftAmplitude');
    expect(result.renderQuality).toBe('full');
    expect(result.edgeLabelsVisible).toBe(true);
    expect(result.nodeDetailsVisible).toBe(true);
  });

  it('filters by categories and removes disconnected edges', () => {
    const result = buildKnowledgeFlowGraph({
      payload,
      query: '',
      enabledCategories: new Set(['project', 'assistant']),
      maxRenderNodes: 100,
      maxRenderEdges: 100,
      currentZoom: 1,
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['e1']);
  });

  it('filters by case-insensitive query over labels', () => {
    const result = buildKnowledgeFlowGraph({
      payload,
      query: 'clau',
      enabledCategories: new Set(['project', 'assistant', 'tool', 'organization']),
      maxRenderNodes: 100,
      maxRenderEdges: 100,
      currentZoom: 1,
    });

    expect(result.nodes.map((node) => node.id)).toEqual(['n2']);
    expect(result.edges).toHaveLength(0);
  });

  it('enforces max render limits and marks result as truncated', () => {
    const result = buildKnowledgeFlowGraph({
      payload,
      query: '',
      enabledCategories: new Set(['project', 'assistant', 'tool', 'organization']),
      maxRenderNodes: 2,
      maxRenderEdges: 1,
      currentZoom: 1,
    });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges.length).toBeLessThanOrEqual(1);
    expect(result.truncated).toBe(true);
  });

  it('switches to performance render quality for dense graphs and disables heavy edge animations', () => {
    const denseNodeCount = 420;
    const denseNodes = Array.from({ length: denseNodeCount }, (_, index) => ({
      id: `n-${index + 1}`,
      label: `Node ${index + 1}`,
      category: index % 2 === 0 ? 'concept' : 'person',
      owner: 'persona' as const,
      aliasCount: 0,
    }));
    const denseEdges = Array.from({ length: 1800 }, (_, index) => ({
      id: `e-${index + 1}`,
      source: `n-${(index % denseNodeCount) + 1}`,
      target: `n-${((index + 7) % denseNodeCount) + 1}`,
      relationType: 'related_to',
      confidence: 0.92,
    }));

    const result = buildKnowledgeFlowGraph({
      payload: {
        graph: {
          nodes: denseNodes,
          edges: denseEdges,
        },
        stats: {
          nodes: denseNodes.length,
          edges: denseEdges.length,
          categories: {
            concept: denseNodeCount / 2,
            person: denseNodeCount / 2,
          },
          truncated: false,
        },
      },
      query: '',
      enabledCategories: new Set(['concept', 'person']),
      maxRenderNodes: 500,
      maxRenderEdges: 3_000,
      currentZoom: 1,
    });

    expect(result.renderQuality).toBe('performance');
    expect(result.edges.every((edge) => edge.animated === false)).toBe(true);
    expect(result.edgeLabelsVisible).toBe(false);
  });

  it('reduces node details on low zoom level (LOD)', () => {
    const result = buildKnowledgeFlowGraph({
      payload,
      query: '',
      enabledCategories: new Set(['project', 'assistant', 'tool', 'organization']),
      maxRenderNodes: 100,
      maxRenderEdges: 100,
      currentZoom: 0.35,
    });

    expect(result.nodeDetailsVisible).toBe(false);
    expect(result.nodes.every((node) => node.data.showMeta === false)).toBe(true);
  });

  it('returns only connected component when a focused node is provided', () => {
    const disconnectedPayload: KnowledgeGraphApiPayload = {
      graph: {
        nodes: [
          { id: 'a1', label: 'A1', category: 'project', owner: 'persona', aliasCount: 0 },
          { id: 'a2', label: 'A2', category: 'project', owner: 'persona', aliasCount: 0 },
          { id: 'a3', label: 'A3', category: 'project', owner: 'persona', aliasCount: 0 },
          { id: 'b1', label: 'B1', category: 'project', owner: 'persona', aliasCount: 0 },
          { id: 'b2', label: 'B2', category: 'project', owner: 'persona', aliasCount: 0 },
        ],
        edges: [
          { id: 'ea1', source: 'a1', target: 'a2', relationType: 'rel', confidence: 1 },
          { id: 'ea2', source: 'a2', target: 'a3', relationType: 'rel', confidence: 1 },
          { id: 'eb1', source: 'b1', target: 'b2', relationType: 'rel', confidence: 1 },
        ],
      },
      stats: {
        nodes: 5,
        edges: 3,
        categories: { project: 5 },
        truncated: false,
      },
    };

    const full = buildKnowledgeFlowGraph({
      payload: disconnectedPayload,
      query: '',
      enabledCategories: new Set(['project']),
      maxRenderNodes: 100,
      maxRenderEdges: 100,
      currentZoom: 1,
    });

    const focused = filterConnectedFlowSubgraph(full.nodes, full.edges, 'a2');
    expect(focused.nodes.map((node) => node.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(focused.edges.map((edge) => edge.id).sort()).toEqual(['ea1', 'ea2']);
  });
});
