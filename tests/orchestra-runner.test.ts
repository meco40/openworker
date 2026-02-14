import { describe, it, expect, vi } from 'vitest';
import {
  runOrchestraFlow,
  type RunOrchestraFlowInput,
  type ExecuteNodeResult,
  type RoutingDecisionFn,
} from '../src/server/worker/orchestraRunner';
import type { OrchestraFlowGraph } from '../src/server/worker/orchestraGraph';

function makeLinearGraph(): OrchestraFlowGraph {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'p-research', position: { x: 0, y: 100 } },
      { id: 'n3', personaId: 'p-review', position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n2', to: 'n3' },
    ],
  };
}

function makeBranchingGraph(): OrchestraFlowGraph {
  return {
    startNodeId: 'n1',
    nodes: [
      { id: 'n1', personaId: 'p-master', position: { x: 0, y: 0 } },
      { id: 'n2', personaId: 'p-research', position: { x: -100, y: 100 } },
      { id: 'n3', personaId: 'p-review', position: { x: 100, y: 100 } },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2' },
      { id: 'e2', from: 'n1', to: 'n3' },
    ],
  };
}

function successExecutor(): (nodeId: string) => Promise<ExecuteNodeResult> {
  return vi.fn(async () => ({ summary: 'Done' }));
}

describe('runOrchestraFlow', () => {
  // ─── Basic execution ──────────────────────────────────────

  it('executes a linear graph in order', async () => {
    const order: string[] = [];
    const executeNode = vi.fn(async (nodeId: string) => {
      order.push(nodeId);
      return { summary: `Completed ${nodeId}` };
    });

    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph: makeLinearGraph(),
      executeNode,
    });

    expect(result.status).toBe('completed');
    expect(order).toEqual(['n1', 'n2', 'n3']);
    expect(executeNode).toHaveBeenCalledTimes(3);
    expect(result.nodes['n1'].status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('completed');
    expect(result.nodes['n1'].summary).toBe('Completed n1');
  });

  it('runs independent branches in parallel', async () => {
    const executeNode = successExecutor();

    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph: makeBranchingGraph(),
      executeNode,
    });

    expect(result.status).toBe('completed');
    // First call is n1, then both n2 and n3 run in the same batch
    expect(executeNode).toHaveBeenCalledTimes(3);
  });

  it('marks pending nodes as skipped on failure', async () => {
    const executeNode = vi.fn(async (nodeId: string) => {
      if (nodeId === 'n1') throw new Error('Boom');
      return { summary: 'Done' };
    });

    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph: makeLinearGraph(),
      executeNode,
    });

    expect(result.status).toBe('failed');
    expect(result.nodes['n1'].status).toBe('failed');
    expect(result.nodes['n1'].error).toBe('Boom');
    expect(result.nodes['n2'].status).toBe('skipped');
    expect(result.nodes['n3'].status).toBe('skipped');
  });

  // ─── Static routing ───────────────────────────────────────

  it('static routing skips non-allowed branches', async () => {
    const graph = makeBranchingGraph();
    // Add static routing on n1: only allow n2
    graph.nodes[0].routing = { mode: 'static', allowedNextNodeIds: ['n2'] };

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
    });

    expect(result.status).toBe('completed');
    expect(result.nodes['n1'].status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('skipped');
  });

  it('static routing follows all edges when allowedNextNodeIds is empty', async () => {
    const graph = makeBranchingGraph();
    // Static routing without allowedNextNodeIds = follow all
    graph.nodes[0].routing = { mode: 'static' };

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
    });

    expect(result.status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('completed');
  });

  it('static routing does not trigger on single-edge nodes', async () => {
    const graph = makeLinearGraph();
    // Add static routing on n1 with only n2 as an edge — it has only 1 edge so routing is skipped
    graph.nodes[0].routing = { mode: 'static', allowedNextNodeIds: ['n2'] };

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
    });

    expect(result.status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('completed');
  });

  // ─── LLM routing ─────────────────────────────────────────

  it('LLM routing uses decideLlmRouting to select branches', async () => {
    const graph = makeBranchingGraph();
    graph.nodes[0].routing = { mode: 'llm', allowedNextNodeIds: ['n2', 'n3'] };

    const decideLlmRouting: RoutingDecisionFn = vi.fn(async () => ({
      chosenNodeIds: ['n3'],
      reason: 'Research not needed',
    }));

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
      decideLlmRouting,
    });

    expect(result.status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('skipped');
    expect(result.nodes['n3'].status).toBe('completed');
    expect(result.nodes['n1'].routingDecision).toEqual({
      chosenNodeIds: ['n3'],
      reason: 'Research not needed',
    });
    expect(decideLlmRouting).toHaveBeenCalledTimes(1);
  });

  it('LLM routing falls back to all edges on failure', async () => {
    const graph = makeBranchingGraph();
    graph.nodes[0].routing = { mode: 'llm', allowedNextNodeIds: ['n2', 'n3'] };

    const decideLlmRouting: RoutingDecisionFn = vi.fn(async () => {
      throw new Error('LLM unavailable');
    });

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
      decideLlmRouting,
    });

    // On LLM failure, should fall back to following all edges
    expect(result.status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('completed');
  });

  it('LLM routing is skipped when decideLlmRouting is not provided', async () => {
    const graph = makeBranchingGraph();
    graph.nodes[0].routing = { mode: 'llm', allowedNextNodeIds: ['n2', 'n3'] };

    const executeNode = successExecutor();
    const result = await runOrchestraFlow({
      taskId: 'task-1',
      flowPublishedId: 'flow-1',
      graph,
      executeNode,
      // No decideLlmRouting provided
    });

    // Should fall through — both branches executed
    expect(result.status).toBe('completed');
    expect(result.nodes['n2'].status).toBe('completed');
    expect(result.nodes['n3'].status).toBe('completed');
  });

  // ─── Result shape ────────────────────────────────────────

  it('returns correct result shape', async () => {
    const result = await runOrchestraFlow({
      taskId: 'task-42',
      flowPublishedId: 'flow-99',
      graph: makeLinearGraph(),
      executeNode: successExecutor(),
    });

    expect(result.taskId).toBe('task-42');
    expect(result.flowPublishedId).toBe('flow-99');
    expect(result.status).toBe('completed');
    expect(Object.keys(result.nodes)).toHaveLength(3);

    for (const nodeState of Object.values(result.nodes)) {
      expect(nodeState.completedAt).toBeTruthy();
      expect(nodeState.startedAt).toBeTruthy();
    }
  });
});
