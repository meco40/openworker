// Jeder Node-Typ, der im Flow existieren kann
export type FlowNodeType =
  | 'trigger.cron'
  | 'trigger.webhook'
  | 'trigger.manual'
  | 'condition.filter'
  | 'condition.ai_classifier'
  | 'condition.regex'
  | 'action.run_prompt'
  | 'action.skill'
  | 'action.send_message'
  | 'action.notify';

export interface FlowNodeData {
  label: string;
  config: Record<string, unknown>; // node-type-spezifische Konfiguration
  [key: string]: unknown;
}

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string; // FlowNode.id
  target: string; // FlowNode.id
  sourceHandle?: string; // 'true' | 'false' für Condition-Nodes
  label?: string;
}

export interface FlowGraph {
  version: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
