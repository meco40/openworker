import type { OrchestraFlowGraph } from './orchestraGraph';

export type OrchestraNodeRuntimeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export function getIncomingDependencies(graph: OrchestraFlowGraph): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const node of graph.nodes) {
    dependencies.set(node.id, []);
  }

  for (const edge of graph.edges) {
    const list = dependencies.get(edge.to);
    if (!list) continue;
    list.push(edge.from);
  }

  return dependencies;
}

export function getRunnableNodeIds(
  graph: OrchestraFlowGraph,
  nodeStatus: Record<string, OrchestraNodeRuntimeStatus>,
): string[] {
  const dependencies = getIncomingDependencies(graph);
  const runnable: string[] = [];

  for (const node of graph.nodes) {
    const status = nodeStatus[node.id] ?? 'pending';
    if (status !== 'pending') continue;

    const nodeDeps = dependencies.get(node.id) ?? [];
    const allDepsCompleted = nodeDeps.every((depNodeId) => nodeStatus[depNodeId] === 'completed');
    if (allDepsCompleted) {
      runnable.push(node.id);
    }
  }

  return runnable;
}
