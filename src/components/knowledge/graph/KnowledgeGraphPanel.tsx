'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  buildKnowledgeFlowGraph,
  filterConnectedFlowSubgraph,
} from '@/components/knowledge/graph/knowledgeGraphTransform';
import { KnowledgeNode } from '@/components/knowledge/graph/KnowledgeNode';
import { buildNodeRelationDetails } from '@/components/knowledge/graph/nodeDetails';
import type {
  KnowledgeFlowEdge,
  KnowledgeFlowNode,
  KnowledgeGraphApiPayload,
} from '@/components/knowledge/graph/types';

const nodeTypes: NodeTypes = {
  knowledge: KnowledgeNode as NodeTypes['knowledge'],
};

interface KnowledgeGraphPanelProps {
  payload: KnowledgeGraphApiPayload | null;
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
}

function KnowledgeGraphCanvas({ payload, loading, error, onReload }: KnowledgeGraphPanelProps) {
  const allCategories = useMemo(
    () =>
      Object.keys(payload?.stats.categories || {}).sort((left, right) => left.localeCompare(right)),
    [payload],
  );
  const [query, setQuery] = useState('');
  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(new Set(allCategories));
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [detailVisibleCount, setDetailVisibleCount] = useState(20);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [currentZoom, setCurrentZoom] = useState(1);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomPendingRef = useRef(1);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    KnowledgeFlowNode,
    KnowledgeFlowEdge
  > | null>(null);

  const commitZoom = useCallback((nextZoom: number) => {
    if (!Number.isFinite(nextZoom)) return;
    zoomPendingRef.current = nextZoom;
    if (zoomFrameRef.current !== null) return;
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      setCurrentZoom((previous) =>
        Math.abs(previous - zoomPendingRef.current) > 0.08 ? zoomPendingRef.current : previous,
      );
    });
  }, []);

  useEffect(() => {
    const element = graphViewportRef.current;
    if (!element) return;

    const updateViewport = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      setViewport((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : {
              width,
              height,
            },
      );
    };

    updateViewport();

    if (typeof ResizeObserver === 'undefined') {
      const intervalId = window.setInterval(updateViewport, 250);
      return () => window.clearInterval(intervalId);
    }

    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setEnabledCategories((previous) => {
      const next = new Set<string>();
      for (const category of allCategories) {
        if (previous.has(category) || previous.size === 0) {
          next.add(category);
        }
      }
      if (next.size === 0) {
        for (const category of allCategories) next.add(category);
      }
      return next;
    });
  }, [allCategories]);

  const transformed = useMemo(
    () =>
      payload
        ? buildKnowledgeFlowGraph({
            payload,
            query,
            enabledCategories,
            maxRenderNodes: 500,
            maxRenderEdges: 3_000,
            currentZoom,
          })
        : null,
    [payload, query, enabledCategories, currentZoom],
  );

  useEffect(() => {
    if (!focusedNodeId || !transformed) return;
    if (!transformed.nodes.some((node) => node.id === focusedNodeId)) {
      setFocusedNodeId(null);
    }
  }, [focusedNodeId, transformed]);

  useEffect(() => {
    setDetailVisibleCount(20);
  }, [focusedNodeId]);

  const nodeDetails = useMemo(
    () => buildNodeRelationDetails(payload, focusedNodeId),
    [focusedNodeId, payload],
  );
  const visibleRelations = useMemo(
    () => nodeDetails?.relations.slice(0, detailVisibleCount) || [],
    [detailVisibleCount, nodeDetails?.relations],
  );
  const hasMoreDetails = Boolean(nodeDetails && nodeDetails.relations.length > detailVisibleCount);

  const graphToRender = useMemo(() => {
    if (!transformed) return null;
    return filterConnectedFlowSubgraph(transformed.nodes, transformed.edges, focusedNodeId);
  }, [focusedNodeId, transformed]);

  const [nodes, setNodes, onNodesChange] = useNodesState<KnowledgeFlowNode>(
    graphToRender?.nodes || [],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<KnowledgeFlowEdge>(
    graphToRender?.edges || [],
  );

  useEffect(() => {
    setNodes(graphToRender?.nodes || []);
    setEdges(graphToRender?.edges || []);
  }, [graphToRender?.edges, graphToRender?.nodes, setEdges, setNodes]);

  useEffect(() => {
    if (!flowInstance || nodes.length === 0) return;
    const timer = setTimeout(() => {
      flowInstance.fitView({ padding: 0.16, duration: 280 });
    }, 32);
    return () => clearTimeout(timer);
  }, [edges.length, flowInstance, nodes.length]);

  const totalNodes = payload?.stats.nodes || 0;
  const totalEdges = payload?.stats.edges || 0;
  const visibleNodes = graphToRender?.nodes.length || 0;
  const visibleEdges = graphToRender?.edges.length || 0;

  return (
    <section className="flex h-full min-h-[70vh] flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/70">
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-black tracking-widest text-zinc-100 uppercase">
              Knowledge Graph
            </h2>
            <p className="text-xs text-zinc-500">
              Dynamischer Entity-Graph mit Zoom, Suche und Kategorien.
            </p>
          </div>
          <button
            onClick={() => void onReload()}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Neu laden
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="text-[10px] tracking-widest text-zinc-500 uppercase">Nodes</div>
            <div className="text-lg font-semibold text-cyan-300">{visibleNodes}</div>
            <div className="text-[10px] text-zinc-500">von {totalNodes}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="text-[10px] tracking-widest text-zinc-500 uppercase">Edges</div>
            <div className="text-lg font-semibold text-emerald-300">{visibleEdges}</div>
            <div className="text-[10px] text-zinc-500">von {totalEdges}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="text-[10px] tracking-widest text-zinc-500 uppercase">Kategorien</div>
            <div className="text-lg font-semibold text-violet-300">{allCategories.length}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <div className="text-[10px] tracking-widest text-zinc-500 uppercase">Render</div>
            <div className="text-lg font-semibold text-amber-300">
              {transformed
                ? `${transformed.renderQuality}${transformed.truncated ? ' • Truncated' : ''}`
                : 'n/a'}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Node suchen..."
            className="min-w-[220px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-500"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {focusedNodeId ? (
            <button
              onClick={() => setFocusedNodeId(null)}
              className="rounded-full border border-amber-500/60 bg-amber-500/15 px-3 py-1 text-[11px] font-semibold tracking-wide text-amber-200"
            >
              Focus aktiv (zurücksetzen)
            </button>
          ) : null}
          {allCategories.map((category) => {
            const enabled = enabledCategories.has(category);
            return (
              <button
                key={category}
                onClick={() =>
                  setEnabledCategories((previous) => {
                    const next = new Set(previous);
                    if (next.has(category)) {
                      next.delete(category);
                    } else {
                      next.add(category);
                    }
                    if (next.size === 0) {
                      next.add(category);
                    }
                    return next;
                  })
                }
                className={`rounded-full border px-3 py-1 text-[11px] font-semibold tracking-wide ${
                  enabled
                    ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                }`}
              >
                {category}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}
      </header>

      <div className="flex min-h-[520px] flex-1">
        <div ref={graphViewportRef} className="relative min-h-[520px] min-w-0 flex-1">
          {!payload && !loading && !error && (
            <div className="p-4 text-sm text-zinc-500">Keine Graph-Daten verfügbar.</div>
          )}
          {loading && (
            <div className="p-4 text-sm text-zinc-500">Knowledge Graph wird geladen...</div>
          )}
          {!!payload && !loading && (
            <div className="h-full w-full">
              {viewport.width > 0 && viewport.height > 0 ? (
                <ReactFlow<KnowledgeFlowNode, KnowledgeFlowEdge>
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onMove={(_event, flowViewport) => {
                    commitZoom(flowViewport.zoom);
                  }}
                  onNodeDragStop={(_event, dragged) => {
                    setNodes((previous) =>
                      previous.map((node) =>
                        node.id === dragged.id
                          ? {
                              ...node,
                              data: {
                                ...node.data,
                                baseX: dragged.position.x,
                                baseY: dragged.position.y,
                              },
                            }
                          : node,
                      ),
                    );
                  }}
                  onNodeClick={(_event, node) => {
                    setFocusedNodeId(node.id);
                  }}
                  onPaneClick={() => {
                    setFocusedNodeId(null);
                  }}
                  onInit={(instance) => {
                    setFlowInstance(instance);
                    commitZoom(instance.getZoom());
                  }}
                  fitView
                  minZoom={0.08}
                  maxZoom={3}
                  nodeTypes={nodeTypes}
                  colorMode="dark"
                  onlyRenderVisibleElements
                  style={{ width: viewport.width, height: viewport.height }}
                  proOptions={{ hideAttribution: true }}
                >
                  <Controls />
                  {transformed?.renderQuality !== 'performance' ? (
                    <MiniMap pannable zoomable nodeStrokeWidth={3} />
                  ) : null}
                  <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                </ReactFlow>
              ) : (
                <div className="p-4 text-sm text-zinc-500">
                  Graph-Viewport wird initialisiert...
                </div>
              )}
            </div>
          )}
        </div>

        {nodeDetails ? (
          <aside className="flex w-[360px] flex-col border-l border-zinc-800 bg-zinc-950/70">
            <div className="border-b border-zinc-800 px-4 py-3">
              <div className="text-[10px] tracking-widest text-zinc-500 uppercase">
                Node Details
              </div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">
                {nodeDetails.node.label}
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Kategorie: {nodeDetails.node.category} • Relations: {nodeDetails.relations.length}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {visibleRelations.length > 0 ? (
                <div className="space-y-2">
                  {visibleRelations.map((relation) => (
                    <div
                      key={relation.id}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2"
                    >
                      <div className="text-xs text-zinc-200">
                        {relation.sourceLabel} --{relation.relationType}--&gt;{' '}
                        {relation.targetLabel}
                      </div>
                      <div className="mt-1 text-[10px] text-zinc-500">
                        {relation.direction === 'outgoing' ? 'ausgehend' : 'eingehend'} • conf:{' '}
                        {relation.confidence.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-500">
                  Für diesen Node wurden keine Verbindungen gefunden.
                </div>
              )}
            </div>

            {hasMoreDetails ? (
              <div className="border-t border-zinc-800 px-4 py-3">
                <button
                  onClick={() => setDetailVisibleCount((previous) => previous + 20)}
                  className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Mehr laden
                </button>
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

export function KnowledgeGraphPanel(props: KnowledgeGraphPanelProps) {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
