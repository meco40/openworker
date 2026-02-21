import type { KnowledgeGraphApiPayload, KnowledgeGraphApiNode } from '@/components/knowledge/graph';

export type KnowledgeNodeRelationDetail = {
  id: string;
  sourceId: string;
  sourceLabel: string;
  targetId: string;
  targetLabel: string;
  relationType: string;
  confidence: number;
  direction: 'incoming' | 'outgoing';
};

export type KnowledgeNodeDetailData = {
  node: KnowledgeGraphApiNode;
  relations: KnowledgeNodeRelationDetail[];
};

export function buildNodeRelationDetails(
  payload: KnowledgeGraphApiPayload | null,
  nodeId: string | null,
): KnowledgeNodeDetailData | null {
  if (!payload || !nodeId) return null;

  const nodeMap = new Map(payload.graph.nodes.map((node) => [node.id, node]));
  const node = nodeMap.get(nodeId);
  if (!node) return null;

  const relations = payload.graph.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => ({
      id: edge.id,
      sourceId: edge.source,
      sourceLabel: nodeMap.get(edge.source)?.label || edge.source,
      targetId: edge.target,
      targetLabel: nodeMap.get(edge.target)?.label || edge.target,
      relationType: edge.relationType,
      confidence: edge.confidence,
      direction: edge.source === nodeId ? ('outgoing' as const) : ('incoming' as const),
    }))
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.relationType.localeCompare(right.relationType);
    });

  return {
    node,
    relations,
  };
}
