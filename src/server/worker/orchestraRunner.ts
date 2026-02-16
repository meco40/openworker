import type { OrchestraFlowGraph, OrchestraGraphNode } from './orchestraGraph';
import { getRunnableNodeIds, type OrchestraNodeRuntimeStatus } from './orchestraScheduler';

export interface OrchestraNodeRunState {
  status: OrchestraNodeRuntimeStatus;
  startedAt: string | null;
  completedAt: string | null;
  summary: string | null;
  error: string | null;
  routingDecision?: { chosenNodeIds: string[]; reason: string };
}

export interface ExecuteNodeResult {
  summary?: string;
}

export type RoutingDecisionFn = (
  node: OrchestraGraphNode,
  outgoingTargetNodeIds: string[],
  nodeSummary: string,
) => Promise<{ chosenNodeIds: string[]; reason: string }>;

export interface RunOrchestraFlowInput {
  taskId: string;
  flowPublishedId: string;
  graph: OrchestraFlowGraph;
  executeNode: (nodeId: string) => Promise<ExecuteNodeResult>;
  /** Optional LLM routing decision function. If omitted, LLM-routing nodes fall back to static. */
  decideLlmRouting?: RoutingDecisionFn;
}

export interface RunOrchestraFlowResult {
  taskId: string;
  flowPublishedId: string;
  status: 'completed' | 'failed';
  nodes: Record<string, OrchestraNodeRunState>;
}

export function collectOpenAiSubagentNodes(
  nodes: Record<string, OrchestraNodeRunState>,
): Array<{ nodeId: string; status: OrchestraNodeRuntimeStatus }> {
  return Object.entries(nodes).map(([nodeId, state]) => ({
    nodeId,
    status: state.status,
  }));
}

function createInitialNodeStates(graph: OrchestraFlowGraph): Record<string, OrchestraNodeRunState> {
  const states: Record<string, OrchestraNodeRunState> = {};
  for (const node of graph.nodes) {
    states[node.id] = {
      status: 'pending',
      startedAt: null,
      completedAt: null,
      summary: null,
      error: null,
    };
  }
  return states;
}

export async function runOrchestraFlow(
  input: RunOrchestraFlowInput,
): Promise<RunOrchestraFlowResult> {
  const nodeStates = createInitialNodeStates(input.graph);

  while (true) {
    if (Object.values(nodeStates).some((node) => node.status === 'failed')) {
      for (const nodeId of Object.keys(nodeStates)) {
        if (nodeStates[nodeId].status === 'pending') {
          nodeStates[nodeId].status = 'skipped';
        }
      }
      return {
        taskId: input.taskId,
        flowPublishedId: input.flowPublishedId,
        status: 'failed',
        nodes: nodeStates,
      };
    }

    const statusMap = Object.fromEntries(
      Object.entries(nodeStates).map(([nodeId, state]) => [nodeId, state.status]),
    ) as Record<string, OrchestraNodeRuntimeStatus>;
    const runnableNodeIds = getRunnableNodeIds(input.graph, statusMap);

    if (runnableNodeIds.length === 0) {
      const hasPending = Object.values(nodeStates).some((node) => node.status === 'pending');
      if (hasPending) {
        for (const nodeId of Object.keys(nodeStates)) {
          if (nodeStates[nodeId].status === 'pending') {
            nodeStates[nodeId].status = 'skipped';
          }
        }
        return {
          taskId: input.taskId,
          flowPublishedId: input.flowPublishedId,
          status: 'failed',
          nodes: nodeStates,
        };
      }

      return {
        taskId: input.taskId,
        flowPublishedId: input.flowPublishedId,
        status: 'completed',
        nodes: nodeStates,
      };
    }

    const now = new Date().toISOString();
    for (const nodeId of runnableNodeIds) {
      nodeStates[nodeId].status = 'running';
      nodeStates[nodeId].startedAt = now;
    }

    const settledResults = await Promise.all(
      runnableNodeIds.map(async (nodeId) => {
        try {
          const result = await input.executeNode(nodeId);
          return { nodeId, ok: true as const, result };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { nodeId, ok: false as const, error: message };
        }
      }),
    );

    const completedAt = new Date().toISOString();
    for (const settledResult of settledResults) {
      if (settledResult.ok) {
        const { nodeId, result } = settledResult;
        nodeStates[nodeId].status = 'completed';
        nodeStates[nodeId].completedAt = completedAt;
        nodeStates[nodeId].summary = result.summary ?? null;
        nodeStates[nodeId].error = null;
        continue;
      }

      const failedNodeId = settledResult.nodeId;
      nodeStates[failedNodeId].status = 'failed';
      nodeStates[failedNodeId].completedAt = completedAt;
      nodeStates[failedNodeId].error = settledResult.error;
    }

    // ─── Post-completion routing decisions (pre-skip pattern) ────
    for (const settledResult of settledResults) {
      if (!settledResult.ok) continue;
      const { nodeId, result } = settledResult;
      const graphNode = input.graph.nodes.find((n) => n.id === nodeId);
      if (!graphNode?.routing) continue;

      const outgoingEdges = input.graph.edges.filter((e) => e.from === nodeId);
      const outgoingTargetIds = outgoingEdges.map((e) => e.to);
      if (outgoingTargetIds.length <= 1) continue; // No branching to decide

      if (graphNode.routing.mode === 'static') {
        // Static routing: only follow edges to allowedNextNodeIds, skip rest
        const allowed = new Set(graphNode.routing.allowedNextNodeIds ?? outgoingTargetIds);
        for (const targetId of outgoingTargetIds) {
          if (!allowed.has(targetId) && nodeStates[targetId]?.status === 'pending') {
            nodeStates[targetId].status = 'skipped';
          }
        }
      } else if (graphNode.routing.mode === 'llm' && input.decideLlmRouting) {
        // LLM routing: ask LLM which branches to follow
        try {
          const candidateIds = graphNode.routing.allowedNextNodeIds?.length
            ? outgoingTargetIds.filter((id) => graphNode.routing!.allowedNextNodeIds!.includes(id))
            : outgoingTargetIds;

          const decision = await input.decideLlmRouting(
            graphNode,
            candidateIds,
            result.summary ?? '',
          );
          nodeStates[nodeId].routingDecision = decision;

          const chosenSet = new Set(decision.chosenNodeIds);
          for (const targetId of outgoingTargetIds) {
            if (!chosenSet.has(targetId) && nodeStates[targetId]?.status === 'pending') {
              nodeStates[targetId].status = 'skipped';
            }
          }
        } catch (routingError) {
          // On routing failure, fall back to static (follow all allowed edges)
          console.error(`[Orchestra] LLM routing failed for node ${nodeId}:`, routingError);
        }
      }
    }
  }
}
