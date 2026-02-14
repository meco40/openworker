import type { Node, Edge } from '@xyflow/react';
/* eslint-disable import-x/no-named-as-default-member */
import dagre from '@dagrejs/dagre';
import type {
  OrchestraFlowGraph,
  OrchestraGraphNode,
  OrchestraGraphEdge,
} from '../../server/worker/orchestraGraph';

// ─── Types ───────────────────────────────────────────────────

export interface PersonaNodeData extends Record<string, unknown> {
  personaId: string;
  personaName: string;
  personaEmoji: string;
  label: string;
  skillIds: string[];
  isStartNode: boolean;
  routing?: OrchestraGraphNode['routing'];
}

export interface PersonaInfo {
  id: string;
  name: string;
  emoji: string;
}

// ─── Graph → ReactFlow ──────────────────────────────────────

export function orchestraGraphToReactFlow(
  graph: OrchestraFlowGraph,
  personas: PersonaInfo[],
): { nodes: Node<PersonaNodeData>[]; edges: Edge[] } {
  const personaMap = new Map(personas.map((p) => [p.id, p]));
  const startNodeId = graph.startNodeId || graph.nodes[0]?.id;

  const nodes: Node<PersonaNodeData>[] = graph.nodes.map((gNode) => {
    const persona = personaMap.get(gNode.personaId);
    return {
      id: gNode.id,
      type: 'persona',
      position: { x: gNode.position.x, y: gNode.position.y },
      data: {
        personaId: gNode.personaId,
        personaName: persona?.name ?? gNode.personaId,
        personaEmoji: persona?.emoji ?? '🤖',
        label: gNode.label ?? persona?.name ?? gNode.personaId,
        skillIds: gNode.skillIds ?? [],
        isStartNode: gNode.id === startNodeId,
        routing: gNode.routing,
      },
    };
  });

  const edges: Edge[] = graph.edges.map((gEdge) => ({
    id: gEdge.id,
    source: gEdge.from,
    target: gEdge.to,
    label: gEdge.label,
    sourceHandle: gEdge.sourceHandle,
    targetHandle: gEdge.targetHandle,
    type: gEdge.label ? 'condition' : 'default',
    animated: false,
  }));

  return { nodes, edges };
}

// ─── ReactFlow → Graph ──────────────────────────────────────

export function reactFlowToOrchestraGraph(
  nodes: Node<PersonaNodeData>[],
  edges: Edge[],
): OrchestraFlowGraph {
  const startNode = nodes.find((n) => n.data.isStartNode) ?? nodes[0];

  const graphNodes: OrchestraGraphNode[] = nodes.map((rfNode) => {
    const gNode: OrchestraGraphNode = {
      id: rfNode.id,
      personaId: rfNode.data.personaId,
      position: { x: rfNode.position.x, y: rfNode.position.y },
    };
    if (rfNode.data.label) gNode.label = rfNode.data.label;
    if (rfNode.data.skillIds.length > 0) gNode.skillIds = rfNode.data.skillIds;
    if (rfNode.data.routing) gNode.routing = rfNode.data.routing;
    return gNode;
  });

  const graphEdges: OrchestraGraphEdge[] = edges.map((rfEdge) => {
    const gEdge: OrchestraGraphEdge = {
      id: rfEdge.id,
      from: rfEdge.source,
      to: rfEdge.target,
    };
    if (rfEdge.label && typeof rfEdge.label === 'string') gEdge.label = rfEdge.label;
    if (rfEdge.sourceHandle) gEdge.sourceHandle = rfEdge.sourceHandle;
    if (rfEdge.targetHandle) gEdge.targetHandle = rfEdge.targetHandle;
    return gEdge;
  });

  return {
    startNodeId: startNode?.id,
    nodes: graphNodes,
    edges: graphEdges,
  };
}

// ─── Auto-Layout (dagre) ────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 100;

export function autoLayoutGraph(
  nodes: Node<PersonaNodeData>[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): Node<PersonaNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 80, ranksep: 120, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const dagreNode = g.node(node.id);
    return {
      ...node,
      position: {
        x: dagreNode.x - NODE_WIDTH / 2,
        y: dagreNode.y - NODE_HEIGHT / 2,
      },
    };
  });
}
