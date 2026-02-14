export type OrchestraRoutingMode = 'static' | 'llm';

export interface OrchestraGraphNodeRouting {
  mode: OrchestraRoutingMode;
  allowedNextNodeIds?: string[];
}

export interface OrchestraGraphNode {
  id: string;
  personaId: string;
  routing?: OrchestraGraphNodeRouting;
}

export interface OrchestraGraphEdge {
  from: string;
  to: string;
}

export interface OrchestraFlowGraph {
  startNodeId?: string;
  nodes: OrchestraGraphNode[];
  edges: OrchestraGraphEdge[];
}
