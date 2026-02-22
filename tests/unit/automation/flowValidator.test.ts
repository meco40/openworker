import { describe, it, expect } from 'vitest';
import { validateFlowGraph } from '@/server/automation/flowValidator';
import type { FlowGraph } from '@/server/automation/flowTypes';

const minimalGraph: FlowGraph = {
  version: 1,
  nodes: [
    {
      id: 'n1',
      type: 'trigger.cron',
      position: { x: 0, y: 0 },
      data: { label: 'Every hour', config: { cronExpression: '0 * * * *', timezone: 'UTC' } },
    },
  ],
  edges: [],
};

describe('validateFlowGraph', () => {
  it('accepts a minimal valid graph with one trigger', () => {
    const result = validateFlowGraph(minimalGraph);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects graph with no trigger node', () => {
    const graph: FlowGraph = { version: 1, nodes: [], edges: [] };
    const result = validateFlowGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('NO_TRIGGER');
  });

  it('rejects graph with more than one trigger', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron',
          position: { x: 0, y: 0 },
          data: { label: 'T1', config: { cronExpression: '0 * * * *', timezone: 'UTC' } },
        },
        {
          id: 'n2',
          type: 'trigger.manual',
          position: { x: 200, y: 0 },
          data: { label: 'T2', config: {} },
        },
      ],
      edges: [],
    };
    const result = validateFlowGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('MULTIPLE_TRIGGERS');
  });

  it('rejects cyclic graphs', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron',
          position: { x: 0, y: 0 },
          data: { label: 'T', config: { cronExpression: '0 * * * *', timezone: 'UTC' } },
        },
        {
          id: 'n2',
          type: 'action.run_prompt',
          position: { x: 200, y: 0 },
          data: { label: 'P', config: { prompt: 'test' } },
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' }, // cycle!
      ],
    };
    const result = validateFlowGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('CYCLE_DETECTED');
  });

  it('rejects invalid cron expression in trigger node', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron',
          position: { x: 0, y: 0 },
          data: { label: 'T', config: { cronExpression: 'INVALID', timezone: 'UTC' } },
        },
      ],
      edges: [],
    };
    const result = validateFlowGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('INVALID_CRON_EXPRESSION');
  });

  it('accepts manual trigger (no cron validation needed)', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.manual',
          position: { x: 0, y: 0 },
          data: { label: 'Manual', config: {} },
        },
      ],
      edges: [],
    };
    const result = validateFlowGraph(graph);
    expect(result.valid).toBe(true);
  });
});
