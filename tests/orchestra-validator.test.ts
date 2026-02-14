import { describe, it, expect } from 'vitest';
import {
  validateOrchestraGraph,
  type OrchestraValidationOptions,
} from '../src/server/worker/orchestraValidator';
import type { OrchestraFlowGraph } from '../src/server/worker/orchestraGraph';

function makeValidGraph(overrides?: Partial<OrchestraFlowGraph>): OrchestraFlowGraph {
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

describe('validateOrchestraGraph', () => {
  it('passes for a valid graph', () => {
    const result = validateOrchestraGraph(makeValidGraph());
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object input', () => {
    const result = validateOrchestraGraph('not a graph');
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('invalid_graph_shape');
  });

  it('rejects null input', () => {
    const result = validateOrchestraGraph(null);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('invalid_graph_shape');
  });

  // ─── Position validation ─────────────────────────────────

  it('rejects node without position', () => {
    const graph = {
      startNodeId: 'n1',
      nodes: [{ id: 'n1', personaId: 'p-master' }],
      edges: [],
    };
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    const posError = result.errors.find((e) => e.code === 'missing_position');
    expect(posError).toBeDefined();
    expect(posError!.nodeId).toBe('n1');
  });

  it('rejects node with non-numeric position', () => {
    const graph = {
      startNodeId: 'n1',
      nodes: [{ id: 'n1', personaId: 'p-master', position: { x: 'abc', y: 0 } }],
      edges: [],
    };
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'missing_position')).toBe(true);
  });

  // ─── Edge ID validation ──────────────────────────────────

  it('rejects edge without id', () => {
    const graph = {
      startNodeId: 'n1',
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    };
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'missing_edge_id')).toBe(true);
  });

  it('rejects duplicate edge ids', () => {
    const graph = makeValidGraph({
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
        { id: 'n3', personaId: 'p-review', position: { x: 200, y: 200 } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e1', from: 'n1', to: 'n3' },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'duplicate_edge_id')).toBe(true);
  });

  // ─── Skill validation ────────────────────────────────────

  it('rejects invalid skill ids when allowedSkillIds provided', () => {
    const graph = makeValidGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          skillIds: ['sk-valid', 'sk-fake'],
        },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
    });
    const opts: OrchestraValidationOptions = {
      allowedSkillIds: new Set(['sk-valid']),
    };
    const result = validateOrchestraGraph(graph, opts);
    expect(result.ok).toBe(false);
    const skillErr = result.errors.find((e) => e.code === 'invalid_skill_id');
    expect(skillErr).toBeDefined();
    expect(skillErr!.message).toContain('sk-fake');
  });

  it('accepts valid skill ids', () => {
    const graph = makeValidGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          skillIds: ['sk-valid'],
        },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
    });
    const opts: OrchestraValidationOptions = {
      allowedSkillIds: new Set(['sk-valid']),
    };
    const result = validateOrchestraGraph(graph, opts);
    expect(result.ok).toBe(true);
  });

  it('skips skill validation when allowedSkillIds not provided', () => {
    const graph = makeValidGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          skillIds: ['any-skill'],
        },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(true);
  });

  // ─── Existing validations still work ─────────────────────

  it('detects duplicate node ids', () => {
    const graph = makeValidGraph({
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
        { id: 'n1', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'duplicate_node_id')).toBe(true);
  });

  it('detects cycles', () => {
    const graph = makeValidGraph({
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n1' },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'cycle_detected')).toBe(true);
  });

  it('detects orphan nodes', () => {
    const graph = makeValidGraph({
      nodes: [
        { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
        { id: 'n3', personaId: 'p-review', position: { x: 200, y: 200 } },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'orphan_node')).toBe(true);
  });

  it('detects unknown edge nodes', () => {
    const graph = makeValidGraph({
      edges: [{ id: 'e1', from: 'n1', to: 'n999' }],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unknown_edge_node')).toBe(true);
  });

  // ─── LLM routing validation ──────────────────────────────

  it('detects routing_option_not_reachable for LLM routing', () => {
    const graph = makeValidGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          routing: { mode: 'llm', allowedNextNodeIds: ['n3'] },
        },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
        { id: 'n3', personaId: 'p-review', position: { x: 200, y: 200 } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n3' },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(false);
    const routeErr = result.errors.find((e) => e.code === 'routing_option_not_reachable');
    expect(routeErr).toBeDefined();
    expect(routeErr!.nodeId).toBe('n1');
  });

  it('passes when LLM routing targets are reachable', () => {
    const graph = makeValidGraph({
      nodes: [
        {
          id: 'n1',
          personaId: 'p-master',
          position: { x: 0, y: 0 },
          routing: { mode: 'llm', allowedNextNodeIds: ['n2'] },
        },
        { id: 'n2', personaId: 'p-research', position: { x: 100, y: 100 } },
      ],
    });
    const result = validateOrchestraGraph(graph);
    expect(result.ok).toBe(true);
  });

  // ─── unauthorized persona ────────────────────────────────

  it('rejects unauthorized persona when allowedPersonaIds provided', () => {
    const opts: OrchestraValidationOptions = {
      allowedPersonaIds: new Set(['p-master']),
    };
    const result = validateOrchestraGraph(makeValidGraph(), opts);
    expect(result.ok).toBe(false);
    const personaErr = result.errors.find((e) => e.code === 'unauthorized_persona');
    expect(personaErr).toBeDefined();
    expect(personaErr!.nodeId).toBe('n2');
  });
});
