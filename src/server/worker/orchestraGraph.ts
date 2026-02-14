export type OrchestraRoutingMode = 'static' | 'llm';

export interface OrchestraGraphNodeRouting {
  mode: OrchestraRoutingMode;
  allowedNextNodeIds?: string[];
}

export interface OrchestraNodePosition {
  x: number;
  y: number;
}

export interface OrchestraGraphNode {
  id: string;
  personaId: string;
  position: OrchestraNodePosition;
  label?: string;
  skillIds?: string[];
  routing?: OrchestraGraphNodeRouting;
}

export interface OrchestraGraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface OrchestraFlowGraph {
  startNodeId?: string;
  nodes: OrchestraGraphNode[];
  edges: OrchestraGraphEdge[];
}
