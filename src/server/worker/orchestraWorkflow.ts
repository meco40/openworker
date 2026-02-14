import type { OrchestraFlowGraph } from './orchestraGraph';
import type { WorkerRunNodeRecord } from './orchestraTypes';

export type WorkerWorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkerWorkflowNodeView {
  id: string;
  personaId: string | null;
  status: WorkerWorkflowNodeStatus;
}

export interface WorkerWorkflowPayload {
  taskId: string;
  runId: string | null;
  flowPublishedId: string | null;
  nodes: WorkerWorkflowNodeView[];
  edges: Array<{ from: string; to: string }>;
  activePath: string[];
  currentNodeId: string | null;
  timestamp: string;
}

export function buildWorkerWorkflowPayload(input: {
  taskId: string;
  runId: string | null;
  flowPublishedId: string | null;
  graph: OrchestraFlowGraph;
  nodeStatuses: Record<string, WorkerWorkflowNodeStatus>;
  timestamp?: string;
}): WorkerWorkflowPayload {
  const nodes = input.graph.nodes.map((node) => ({
    id: node.id,
    personaId: node.personaId || null,
    status: input.nodeStatuses[node.id] || 'pending',
  }));
  const currentNode = nodes.find((node) => node.status === 'running') || null;
  const activePath = nodes
    .filter((node) => node.status === 'running' || node.status === 'completed')
    .map((node) => node.id);

  return {
    taskId: input.taskId,
    runId: input.runId,
    flowPublishedId: input.flowPublishedId,
    nodes,
    edges: input.graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    activePath,
    currentNodeId: currentNode?.id || null,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}

export function buildNodeStatusMap(
  runNodes: WorkerRunNodeRecord[],
): Record<string, WorkerWorkflowNodeStatus> {
  const map: Record<string, WorkerWorkflowNodeStatus> = {};
  for (const runNode of runNodes) {
    map[runNode.nodeId] = runNode.status;
  }
  return map;
}
