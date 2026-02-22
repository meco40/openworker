import { describe, it, expect } from 'vitest';
import type { FlowGraph } from '@/server/automation/flowTypes';
import { toRule } from '@/server/automation/automationRowMappers';

describe('FlowGraph type', () => {
  it('version must be 1', () => {
    const graph: FlowGraph = { version: 1, nodes: [], edges: [] };
    expect(graph.version).toBe(1);
  });

  it('AutomationRule.flowGraph defaults to null for legacy rules (row without flow_graph)', () => {
    const row = {
      id: 'r1',
      user_id: 'u1',
      name: 'test',
      cron_expression: '0 * * * *',
      timezone: 'UTC',
      prompt: 'x',
      enabled: 1,
      next_run_at: null,
      last_run_at: null,
      consecutive_failures: 0,
      last_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      flow_graph: null,
    };
    const rule = toRule(row);
    expect(rule.flowGraph).toBeNull();
  });

  it('toRule parses valid flow_graph JSON', () => {
    const graph: FlowGraph = { version: 1, nodes: [], edges: [] };
    const row = {
      id: 'r1',
      user_id: 'u1',
      name: 'test',
      cron_expression: '0 * * * *',
      timezone: 'UTC',
      prompt: 'x',
      enabled: 1,
      next_run_at: null,
      last_run_at: null,
      consecutive_failures: 0,
      last_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      flow_graph: JSON.stringify(graph),
    };
    const rule = toRule(row);
    expect(rule.flowGraph).toEqual(graph);
  });

  it('toRule returns null for corrupt flow_graph JSON', () => {
    const row = {
      id: 'r1',
      user_id: 'u1',
      name: 'test',
      cron_expression: '0 * * * *',
      timezone: 'UTC',
      prompt: 'x',
      enabled: 1,
      next_run_at: null,
      last_run_at: null,
      consecutive_failures: 0,
      last_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      flow_graph: 'not-valid-json{{{',
    };
    const rule = toRule(row);
    expect(rule.flowGraph).toBeNull();
  });
});
