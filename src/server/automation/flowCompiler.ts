import type { FlowGraph, FlowNode } from '@/server/automation/flowTypes';

export interface CompiledFlow {
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
}

const NEVER_CRON = '0 0 31 2 *'; // Feb 31 — never fires naturally

function topologicalSort(graph: FlowGraph): FlowNode[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const nodeMap = new Map<string, FlowNode>();

  for (const n of graph.nodes) {
    adj.set(n.id, []);
    inDegree.set(n.id, 0);
    nodeMap.set(n.id, n);
  }
  for (const e of graph.edges) {
    adj.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const queue = graph.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const sorted: FlowNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighborId of adj.get(node.id) ?? []) {
      const neighborNode = nodeMap.get(neighborId);
      if (!neighborNode) continue; // skip dangling edges
      const newDeg = (inDegree.get(neighborId) ?? 1) - 1;
      inDegree.set(neighborId, newDeg);
      if (newDeg === 0) queue.push(neighborNode);
    }
  }

  return sorted;
}

function nodeToPromptStep(node: FlowNode, index: number): string {
  const cfg = node.data.config;

  switch (node.type) {
    case 'trigger.cron':
    case 'trigger.manual':
    case 'trigger.webhook':
      return ''; // triggers don't produce prompt steps

    case 'condition.filter':
      return `Step ${index}: Filter: if ${String(cfg.field)} ${String(cfg.operator)} "${String(cfg.value)}", continue; otherwise stop.`;

    case 'condition.ai_classifier':
      return `Step ${index}: Classify the input using: "${String(cfg.prompt)}". Continue only if category matches.`;

    case 'condition.regex':
      return `Step ${index}: Check if input matches regex /${String(cfg.pattern)}/${String(cfg.flags ?? '')}. Continue if matches.`;

    case 'action.run_prompt':
      return `Step ${index}: ${String(cfg.prompt)}`;

    case 'action.skill':
      return `Step ${index}: Use skill "${String(cfg.skillId)}" with parameters: ${JSON.stringify(cfg)}.`;

    case 'action.send_message':
      return `Step ${index}: Send message to channel "${String(cfg.channelId)}": "${String(cfg.template)}".`;

    case 'action.notify':
      return `Step ${index}: Send notification — Title: "${String(cfg.title)}", Body: "${String(cfg.body)}".`;

    default: {
      // exhaustive check — TypeScript will warn if a new FlowNodeType is added without handling it
      const _exhaustive: never = node.type;
      return `Step ${index}: Execute node "${node.data.label}". (${String(_exhaustive)})`;
    }
  }
}

export function compileFlow(graph: FlowGraph): CompiledFlow {
  const sorted = topologicalSort(graph);
  const triggerNode = sorted.find((n) => n.type.startsWith('trigger.'));

  let cronExpression = NEVER_CRON;
  let timezone = 'UTC';
  let enabled = true;

  if (triggerNode?.type === 'trigger.cron') {
    const cfg = triggerNode.data.config as { cronExpression?: string; timezone?: string };
    cronExpression = cfg.cronExpression ?? NEVER_CRON;
    timezone = cfg.timezone ?? 'UTC';
    enabled = true;
  } else if (triggerNode?.type === 'trigger.manual') {
    cronExpression = NEVER_CRON;
    enabled = false;
  } else if (triggerNode?.type === 'trigger.webhook') {
    cronExpression = NEVER_CRON;
    enabled = true;
  }

  const actionNodes = sorted.filter((n) => !n.type.startsWith('trigger.'));
  const steps = actionNodes.map((n, i) => nodeToPromptStep(n, i + 1)).filter((s) => s.length > 0);

  const prompt =
    steps.length > 0
      ? `Execute the following automated workflow:\n\n${steps.join('\n\n')}`
      : 'Automated flow with no action steps.';

  return { cronExpression, timezone, prompt, enabled };
}
