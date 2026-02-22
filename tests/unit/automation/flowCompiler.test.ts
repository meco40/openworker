import { describe, it, expect } from 'vitest';
import { compileFlow } from '@/server/automation/flowCompiler';
import type { FlowGraph } from '@/server/automation/flowTypes';

describe('compileFlow', () => {
  it('extracts cronExpression from cron trigger node', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron',
          position: { x: 0, y: 0 },
          data: {
            label: 'Every hour',
            config: { cronExpression: '0 * * * *', timezone: 'Europe/Berlin' },
          },
        },
        {
          id: 'n2',
          type: 'action.run_prompt',
          position: { x: 200, y: 0 },
          data: { label: 'Search news', config: { prompt: 'Search for latest AI news' } },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const result = compileFlow(graph);
    expect(result.cronExpression).toBe('0 * * * *');
    expect(result.timezone).toBe('Europe/Berlin');
    expect(result.prompt).toContain('Search for latest AI news');
    expect(result.enabled).toBe(true);
  });

  it('manual trigger sets enabled=false and uses NEVER_CRON sentinel', () => {
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
    const result = compileFlow(graph);
    expect(result.cronExpression).toBe('0 0 31 2 *');
    expect(result.enabled).toBe(false);
  });

  it('includes skill action in generated prompt', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.manual',
          position: { x: 0, y: 0 },
          data: { label: 'Manual', config: {} },
        },
        {
          id: 'n2',
          type: 'action.skill',
          position: { x: 200, y: 0 },
          data: { label: 'Web Search', config: { skillId: 'search', query: 'AI news' } },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const result = compileFlow(graph);
    expect(result.prompt).toContain('search');
    expect(result.prompt).toContain('AI news');
  });

  it('returns fallback prompt when no action nodes exist', () => {
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
    const result = compileFlow(graph);
    expect(result.prompt).toBe('Automated flow with no action steps.');
  });

  it('includes condition step in prompt', () => {
    const graph: FlowGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'trigger.cron',
          position: { x: 0, y: 0 },
          data: {
            label: 'Hourly',
            config: { cronExpression: '0 * * * *', timezone: 'UTC' },
          },
        },
        {
          id: 'n2',
          type: 'condition.filter',
          position: { x: 200, y: 0 },
          data: {
            label: 'Filter urgent',
            config: { field: 'message', operator: 'contains', value: 'urgent' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const result = compileFlow(graph);
    expect(result.prompt).toContain('Filter');
    expect(result.prompt).toContain('urgent');
  });
});
