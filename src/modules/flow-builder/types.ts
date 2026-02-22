import type { Node, Edge } from '@xyflow/react';
import type { FlowNodeData, FlowNodeType } from '@/server/automation/flowTypes';

// ReactFlow-kompatible Node/Edge Typen
export type FlowBuilderNode = Node<FlowNodeData, FlowNodeType>;
export type FlowBuilderEdge = Edge;

export interface NodePaletteItem {
  type: FlowNodeType;
  label: string;
  description: string;
  category: 'trigger' | 'condition' | 'action';
  icon: string;
  defaultConfig: Record<string, unknown>;
  color: string;
}

export const NODE_PALETTE: NodePaletteItem[] = [
  // Triggers
  {
    type: 'trigger.cron',
    label: 'Cron Schedule',
    description: 'Run on a schedule',
    category: 'trigger',
    icon: '⏰',
    defaultConfig: { cronExpression: '0 * * * *', timezone: 'UTC' },
    color: 'bg-violet-700',
  },
  {
    type: 'trigger.manual',
    label: 'Manual Trigger',
    description: 'Run manually',
    category: 'trigger',
    icon: '▶️',
    defaultConfig: {},
    color: 'bg-violet-700',
  },
  {
    type: 'trigger.webhook',
    label: 'Webhook',
    description: 'Trigger via HTTP',
    category: 'trigger',
    icon: '🔗',
    defaultConfig: { webhookPath: '' },
    color: 'bg-violet-700',
  },
  // Conditions
  {
    type: 'condition.filter',
    label: 'Filter',
    description: 'Filter by field value',
    category: 'condition',
    icon: '🔀',
    defaultConfig: { field: 'input', operator: 'contains', value: '' },
    color: 'bg-amber-700',
  },
  {
    type: 'condition.ai_classifier',
    label: 'AI Classifier',
    description: 'Classify with AI',
    category: 'condition',
    icon: '🧠',
    defaultConfig: { prompt: '', categories: [] },
    color: 'bg-amber-700',
  },
  {
    type: 'condition.regex',
    label: 'Regex Match',
    description: 'Match a pattern',
    category: 'condition',
    icon: '🔍',
    defaultConfig: { pattern: '', flags: '' },
    color: 'bg-amber-700',
  },
  // Actions
  {
    type: 'action.run_prompt',
    label: 'AI Prompt',
    description: 'Run an AI prompt',
    category: 'action',
    icon: '💬',
    defaultConfig: { prompt: '' },
    color: 'bg-emerald-700',
  },
  {
    type: 'action.skill',
    label: 'Run Skill',
    description: 'Execute a built-in skill',
    category: 'action',
    icon: '⚡',
    defaultConfig: { skillId: 'search', query: '' },
    color: 'bg-sky-700',
  },
  {
    type: 'action.send_message',
    label: 'Send Message',
    description: 'Send to a channel',
    category: 'action',
    icon: '📨',
    defaultConfig: { channelId: '', template: '{{result}}' },
    color: 'bg-emerald-700',
  },
  {
    type: 'action.notify',
    label: 'Notify',
    description: 'Internal notification',
    category: 'action',
    icon: '🔔',
    defaultConfig: { title: '', body: '' },
    color: 'bg-emerald-700',
  },
];
