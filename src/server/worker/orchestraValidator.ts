import type { OrchestraFlowGraph } from './orchestraGraph';

export type OrchestraValidationErrorCode =
  | 'invalid_graph_shape'
  | 'missing_start_node'
  | 'duplicate_node_id'
  | 'missing_persona'
  | 'unauthorized_persona'
  | 'missing_position'
  | 'missing_edge_id'
  | 'duplicate_edge_id'
  | 'invalid_skill_id'
  | 'unknown_edge_node'
  | 'cycle_detected'
  | 'orphan_node'
  | 'routing_option_not_reachable';

export interface OrchestraValidationError {
  code: OrchestraValidationErrorCode;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

export interface OrchestraValidationResult {
  ok: boolean;
  errors: OrchestraValidationError[];
}

export interface OrchestraValidationOptions {
  allowedPersonaIds?: Set<string>;
  allowedSkillIds?: Set<string>;
}

function isGraphObject(value: unknown): value is OrchestraFlowGraph {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<OrchestraFlowGraph>;
  return Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

export function validateOrchestraGraph(
  graphLike: unknown,
  options?: OrchestraValidationOptions,
): OrchestraValidationResult {
  const errors: OrchestraValidationError[] = [];
  if (!isGraphObject(graphLike)) {
    return {
      ok: false,
      errors: [{ code: 'invalid_graph_shape', message: 'Graph must contain nodes[] and edges[]' }],
    };
  }

  const graph = graphLike;
  const nodeMap = new Map<string, (typeof graph.nodes)[number]>();
  for (const node of graph.nodes) {
    const nodeId = String(node.id || '').trim();
    if (!nodeId) {
      errors.push({ code: 'duplicate_node_id', message: 'Node id is required' });
      continue;
    }
    if (nodeMap.has(nodeId)) {
      errors.push({ code: 'duplicate_node_id', message: `Duplicate node id: ${nodeId}`, nodeId });
      continue;
    }

    const personaId = String(node.personaId || '').trim();
    if (!personaId) {
      errors.push({
        code: 'missing_persona',
        message: `Node ${nodeId} is missing personaId`,
        nodeId,
      });
    } else if (options?.allowedPersonaIds && !options.allowedPersonaIds.has(personaId)) {
      errors.push({
        code: 'unauthorized_persona',
        message: `Node ${nodeId} uses unauthorized persona ${personaId}`,
        nodeId,
      });
    }

    // Position validation
    const pos = node.position;
    if (!pos || typeof pos !== 'object' || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      errors.push({
        code: 'missing_position',
        message: `Node ${nodeId} is missing a valid position {x, y}`,
        nodeId,
      });
    }

    // Skill validation
    if (Array.isArray(node.skillIds) && options?.allowedSkillIds) {
      for (const skillId of node.skillIds) {
        if (!options.allowedSkillIds.has(String(skillId))) {
          errors.push({
            code: 'invalid_skill_id',
            message: `Node ${nodeId} references unknown skill ${skillId}`,
            nodeId,
          });
        }
      }
    }

    nodeMap.set(nodeId, { ...node, id: nodeId, personaId });
  }

  const startNodeId =
    graph.startNodeId && nodeMap.has(graph.startNodeId) ? graph.startNodeId : graph.nodes[0]?.id;
  if (!startNodeId || !nodeMap.has(startNodeId)) {
    errors.push({ code: 'missing_start_node', message: 'Graph start node is missing' });
  }

  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeMap.keys()) {
    adjacency.set(nodeId, []);
  }

  const edgeIdSet = new Set<string>();
  for (const edge of graph.edges) {
    // Edge ID validation
    const edgeId = String(edge.id || '').trim();
    if (!edgeId) {
      errors.push({
        code: 'missing_edge_id',
        message: `Edge ${edge.from} -> ${edge.to} is missing an id`,
        edge: { from: edge.from, to: edge.to },
      });
    } else if (edgeIdSet.has(edgeId)) {
      errors.push({
        code: 'duplicate_edge_id',
        message: `Duplicate edge id: ${edgeId}`,
        edge: { from: edge.from, to: edge.to },
      });
    } else {
      edgeIdSet.add(edgeId);
    }

    const from = String(edge.from || '').trim();
    const to = String(edge.to || '').trim();
    if (!nodeMap.has(from) || !nodeMap.has(to)) {
      errors.push({
        code: 'unknown_edge_node',
        message: `Edge references unknown node: ${from} -> ${to}`,
        edge: { from, to },
      });
      continue;
    }
    adjacency.get(from)?.push(to);
  }

  for (const node of nodeMap.values()) {
    if (node.routing?.mode !== 'llm' || !Array.isArray(node.routing.allowedNextNodeIds)) continue;

    const reachable = new Set(adjacency.get(node.id) ?? []);
    for (const nextId of node.routing.allowedNextNodeIds) {
      if (!reachable.has(nextId)) {
        errors.push({
          code: 'routing_option_not_reachable',
          message: `Node ${node.id} has LLM route option to non-edge node ${nextId}`,
          nodeId: node.id,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (hasCycle(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const nodeId of nodeMap.keys()) {
    if (hasCycle(nodeId)) {
      errors.push({ code: 'cycle_detected', message: 'Graph contains at least one cycle' });
      break;
    }
  }

  if (startNodeId && nodeMap.has(startNodeId)) {
    const reachable = new Set<string>();
    const stack = [startNodeId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!reachable.has(next)) stack.push(next);
      }
    }

    for (const nodeId of nodeMap.keys()) {
      if (!reachable.has(nodeId)) {
        errors.push({ code: 'orphan_node', message: `Node ${nodeId} is not reachable`, nodeId });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
