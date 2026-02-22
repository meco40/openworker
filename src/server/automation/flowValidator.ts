import { validateCronExpression } from '@/server/automation/cronEngine';
import type { FlowGraph, FlowNode } from '@/server/automation/flowTypes';

export interface FlowValidationError {
  code:
    | 'NO_TRIGGER'
    | 'MULTIPLE_TRIGGERS'
    | 'CYCLE_DETECTED'
    | 'INVALID_CRON_EXPRESSION'
    | 'DISCONNECTED_NODE'
    | 'INVALID_NODE_CONFIG';
  nodeId?: string;
  message: string;
}

export interface FlowValidationResult {
  valid: boolean;
  errors: FlowValidationError[];
}

function isTriggerNode(node: FlowNode): boolean {
  return node.type.startsWith('trigger.');
}

function detectCycle(nodes: FlowNode[], edges: FlowGraph['edges']): boolean {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const neighbor of adj.get(nodeId) ?? []) {
      // Check inStack first: if neighbor is an ancestor (back edge) → cycle
      if (inStack.has(neighbor)) return true;
      // If not yet visited, recurse
      if (!visited.has(neighbor) && dfs(neighbor)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const n of nodes) {
    if (!visited.has(n.id) && dfs(n.id)) return true;
  }
  return false;
}

export function validateFlowGraph(graph: FlowGraph): FlowValidationResult {
  const errors: FlowValidationError[] = [];

  // Rule 1: Exactly one trigger
  const triggers = graph.nodes.filter(isTriggerNode);
  if (triggers.length === 0) {
    errors.push({ code: 'NO_TRIGGER', message: 'Flow must have exactly one trigger node.' });
  } else if (triggers.length > 1) {
    errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Flow must have exactly one trigger node.' });
  }

  // Rule 2: No cycles
  if (detectCycle(graph.nodes, graph.edges)) {
    errors.push({ code: 'CYCLE_DETECTED', message: 'Flow graph contains a cycle.' });
  }

  // Rule 3: Cron trigger has valid expression
  for (const node of graph.nodes) {
    if (node.type === 'trigger.cron') {
      const { cronExpression, timezone } = node.data.config as {
        cronExpression?: string;
        timezone?: string;
      };
      if (!cronExpression || !validateCronExpression(cronExpression, timezone ?? 'UTC')) {
        errors.push({
          code: 'INVALID_CRON_EXPRESSION',
          nodeId: node.id,
          message: `Node "${node.data.label}" has an invalid cron expression.`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
