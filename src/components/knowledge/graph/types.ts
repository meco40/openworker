import type { Edge, Node } from '@xyflow/react';

export type KnowledgeRenderQuality = 'full' | 'balanced' | 'performance';

export type KnowledgeGraphApiNode = {
  id: string;
  label: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  aliasCount: number;
};

export type KnowledgeGraphApiEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  confidence: number;
};

export type KnowledgeGraphApiPayload = {
  graph: {
    nodes: KnowledgeGraphApiNode[];
    edges: KnowledgeGraphApiEdge[];
  };
  stats: {
    nodes: number;
    edges: number;
    categories: Record<string, number>;
    truncated: boolean;
  };
};

export type KnowledgeFlowNodeData = {
  label: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  aliasCount: number;
  degree: number;
  color: string;
  driftPhase: number;
  driftAmplitude: number;
  motionEnabled: boolean;
  motionDurationSeconds: number;
  motionDelaySeconds: number;
  motionOffsetX: number;
  motionOffsetY: number;
  showCategory: boolean;
  showMeta: boolean;
  baseX: number;
  baseY: number;
};

export type KnowledgeFlowNode = Node<KnowledgeFlowNodeData>;
export type KnowledgeFlowEdge = Edge;

export type BuildKnowledgeFlowGraphInput = {
  payload: KnowledgeGraphApiPayload;
  query: string;
  enabledCategories: Set<string>;
  maxRenderNodes: number;
  maxRenderEdges: number;
  currentZoom?: number;
};

export type BuildKnowledgeFlowGraphResult = {
  nodes: KnowledgeFlowNode[];
  edges: KnowledgeFlowEdge[];
  categoryCounts: Record<string, number>;
  truncated: boolean;
  renderQuality: KnowledgeRenderQuality;
  edgeLabelsVisible: boolean;
  nodeDetailsVisible: boolean;
};
