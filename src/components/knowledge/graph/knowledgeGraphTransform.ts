import { MarkerType } from '@xyflow/react';
import type {
  BuildKnowledgeFlowGraphInput,
  BuildKnowledgeFlowGraphResult,
  KnowledgeRenderQuality,
  KnowledgeFlowEdge,
  KnowledgeFlowNode,
  KnowledgeGraphApiNode,
} from '@/components/knowledge/graph/types';

const FALLBACK_COLOR = '#94a3b8';
const CATEGORY_COLORS: Record<string, string> = {
  person: '#60a5fa',
  assistant: '#4ade80',
  project: '#22c55e',
  tool: '#f97316',
  decision: '#a855f7',
  date: '#6b7280',
  concept: '#06b6d4',
  location: '#ef4444',
  event: '#eab308',
  organization: '#f43f5e',
  object: '#14b8a6',
  document: '#8b5cf6',
  domain: '#0ea5e9',
  blocker: '#eab308',
  commitment: '#6366f1',
  goal: '#fb7185',
  entity: '#f472b6',
  company: '#fb923c',
  agent: '#60a5fa',
  place: '#a78bfa',
};

function normalizeQuery(input: string): string {
  return input.trim().toLowerCase();
}

function hashText(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function colorForCategory(category: string): string {
  return CATEGORY_COLORS[String(category || '').toLowerCase()] || FALLBACK_COLOR;
}

function buildDegreeMap(
  nodes: KnowledgeGraphApiNode[],
  edges: Array<{ source: string; target: string }>,
): Map<string, number> {
  const degree = new Map<string, number>();
  for (const node of nodes) {
    degree.set(node.id, 0);
  }
  for (const edge of edges) {
    if (degree.has(edge.source)) {
      degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    }
    if (degree.has(edge.target)) {
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
    }
  }
  return degree;
}

function createCategoryCenters(categories: string[]): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const total = Math.max(1, categories.length);
  const radius = total > 1 ? 420 : 0;
  for (let index = 0; index < categories.length; index += 1) {
    const angle = (index / total) * Math.PI * 2;
    result.set(categories[index], {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return result;
}

function resolveRenderQuality(nodeCount: number, edgeCount: number): KnowledgeRenderQuality {
  if (nodeCount > 320 || edgeCount > 1_100) {
    return 'performance';
  }
  if (nodeCount > 180 || edgeCount > 500) {
    return 'balanced';
  }
  return 'full';
}

export function filterConnectedFlowSubgraph(
  nodes: KnowledgeFlowNode[],
  edges: KnowledgeFlowEdge[],
  focusedNodeId: string | null,
): { nodes: KnowledgeFlowNode[]; edges: KnowledgeFlowEdge[] } {
  if (!focusedNodeId) {
    return { nodes, edges };
  }
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  if (!nodeIdSet.has(focusedNodeId)) {
    return { nodes: [], edges: [] };
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const connected = new Set<string>();
  const queue: string[] = [focusedNodeId];
  connected.add(focusedNodeId);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const neighbor of adjacency.get(current) || []) {
      if (connected.has(neighbor)) continue;
      connected.add(neighbor);
      queue.push(neighbor);
    }
  }

  return {
    nodes: nodes.filter((node) => connected.has(node.id)),
    edges: edges.filter((edge) => connected.has(edge.source) && connected.has(edge.target)),
  };
}

export function buildKnowledgeFlowGraph(
  input: BuildKnowledgeFlowGraphInput,
): BuildKnowledgeFlowGraphResult {
  const query = normalizeQuery(input.query);
  const currentZoom = Number.isFinite(input.currentZoom ?? 1) ? Number(input.currentZoom ?? 1) : 1;
  const safeMaxNodes = Math.max(1, Math.floor(input.maxRenderNodes));
  const safeMaxEdges = Math.max(1, Math.floor(input.maxRenderEdges));

  const filteredByQueryAndCategory = input.payload.graph.nodes.filter((node) => {
    if (!input.enabledCategories.has(node.category)) return false;
    if (!query) return true;
    return node.label.toLowerCase().includes(query);
  });

  const categoryCounts: Record<string, number> = {};
  for (const node of filteredByQueryAndCategory) {
    categoryCounts[node.category] = (categoryCounts[node.category] || 0) + 1;
  }

  const nodeTruncated = filteredByQueryAndCategory.length > safeMaxNodes;
  const visibleNodes = filteredByQueryAndCategory.slice(0, safeMaxNodes);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));

  const filteredEdges = input.payload.graph.edges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  );
  const edgeTruncated = filteredEdges.length > safeMaxEdges;
  const visibleEdges = filteredEdges.slice(0, safeMaxEdges);
  const renderQuality = resolveRenderQuality(visibleNodes.length, visibleEdges.length);
  const nodeDetailsVisible = currentZoom >= 0.62 && renderQuality !== 'performance';
  const edgeLabelsVisible =
    currentZoom >= 0.95 && renderQuality === 'full' && visibleEdges.length <= 280;
  const nodeCategoryVisible = currentZoom >= 0.42;
  const nodeMotionEnabled = currentZoom >= 0.45 && renderQuality !== 'performance';

  const degreeMap = buildDegreeMap(visibleNodes, visibleEdges);
  const categories = Array.from(new Set(visibleNodes.map((node) => node.category)));
  const categoryCenters = createCategoryCenters(categories);
  const categoryIndex = new Map<string, number>();

  const nodes: KnowledgeFlowNode[] = visibleNodes.map((node) => {
    const center = categoryCenters.get(node.category) || { x: 0, y: 0 };
    const indexInCategory = categoryIndex.get(node.category) || 0;
    categoryIndex.set(node.category, indexInCategory + 1);

    const localAngle = (indexInCategory % 12) * (Math.PI / 6);
    const localRadius = 90 + Math.floor(indexInCategory / 12) * 56;
    const baseX = center.x + Math.cos(localAngle) * localRadius;
    const baseY = center.y + Math.sin(localAngle) * localRadius;
    const seed = hashText(node.id);

    return {
      id: node.id,
      type: 'knowledge',
      position: { x: baseX, y: baseY },
      draggable: true,
      data: {
        label: node.label,
        category: node.category,
        owner: node.owner,
        aliasCount: node.aliasCount,
        degree: degreeMap.get(node.id) || 0,
        color: colorForCategory(node.category),
        driftPhase: seed % 360,
        driftAmplitude: 2 + (seed % 5),
        motionEnabled: nodeMotionEnabled,
        motionDurationSeconds: 14 + (seed % 7),
        motionDelaySeconds: -((seed % 9) / 2),
        motionOffsetX: 0.5 + (seed % 4) * 0.28,
        motionOffsetY: 0.4 + (seed % 5) * 0.24,
        showCategory: nodeCategoryVisible,
        showMeta: nodeDetailsVisible,
        baseX,
        baseY,
      },
      style: {
        border: `1px solid ${colorForCategory(node.category)}`,
        color: '#e2e8f0',
        background: 'rgba(15, 23, 42, 0.9)',
        borderRadius: 999,
        fontSize: 11,
        padding: '6px 10px',
        boxShadow: `0 0 0 1px ${colorForCategory(node.category)}22, 0 8px 24px rgba(2, 6, 23, 0.55)`,
      },
    };
  });

  const edges: KnowledgeFlowEdge[] = visibleEdges.map((edge, index) => {
    const animated =
      renderQuality === 'full'
        ? visibleEdges.length <= 260
        : renderQuality === 'balanced'
          ? edge.confidence >= 0.9 && index < 220
          : false;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edgeLabelsVisible ? edge.relationType : undefined,
      animated,
      type: 'smoothstep',
      style: {
        stroke: 'rgba(148, 163, 184, 0.45)',
        strokeWidth:
          renderQuality === 'performance' ? 1 : Math.max(1, Math.round(edge.confidence * 2)),
      },
      markerEnd:
        renderQuality === 'performance'
          ? undefined
          : {
              type: MarkerType.ArrowClosed,
              color: 'rgba(148, 163, 184, 0.65)',
              width: 16,
              height: 16,
            },
      labelStyle: {
        fill: '#cbd5e1',
        fontSize: 10,
      },
      labelBgStyle: {
        fill: 'rgba(15, 23, 42, 0.8)',
      },
    };
  });

  return {
    nodes,
    edges,
    categoryCounts,
    truncated: Boolean(input.payload.stats.truncated || nodeTruncated || edgeTruncated),
    renderQuality,
    edgeLabelsVisible,
    nodeDetailsVisible,
  };
}
