'use client';

import React, { useCallback, useEffect, useRef, useMemo, type DragEvent } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
  type OnNodeDrag,
  MarkerType,
} from '@xyflow/react';
import { PersonaNode } from './PersonaNode';
import { ConditionEdge } from './ConditionEdge';
import { useCanvasHistory, type CanvasSnapshot } from './useCanvasHistory';
import type { PersonaNodeData, PersonaInfo } from '../../../src/shared/lib/orchestra-graph-converter';

// ─── Node & Edge type registrations ─────────────────────────

const nodeTypes: NodeTypes = {
  persona: PersonaNode as NodeTypes['persona'],
};

const edgeTypes: EdgeTypes = {
  condition: ConditionEdge as EdgeTypes['condition'],
};

// ─── Default edge options ────────────────────────────────────

const defaultEdgeOptions = {
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#5d7ea9' },
  style: { stroke: '#5d7ea9', strokeWidth: 2 },
};

// ─── Props ───────────────────────────────────────────────────

export interface OrchestraCanvasProps {
  initialNodes: Node<PersonaNodeData>[];
  initialEdges: Edge[];
  personas: PersonaInfo[];
  readOnly?: boolean;
  onGraphChange?: (nodes: Node<PersonaNodeData>[], edges: Edge[]) => void;
  onNodeSelect?: (nodeId: string | null) => void;
  onApiChange?: (api: OrchestraCanvasApi) => void;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Detect if adding an edge source→target would create a cycle (BFS). */
function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  // Add the proposed edge
  const fromSource = adjacency.get(source) ?? [];
  fromSource.push(target);
  adjacency.set(source, fromSource);

  // BFS from target to see if we can reach source
  const visited = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  return false;
}

let idCounter = 0;
function nextEdgeId(): string {
  idCounter += 1;
  return `e-${Date.now()}-${idCounter}`;
}

let nodeCounter = 0;
function nextNodeId(): string {
  nodeCounter += 1;
  return `n-${Date.now()}-${nodeCounter}`;
}

// ─── Component ───────────────────────────────────────────────

export function OrchestraCanvas({
  initialNodes,
  initialEdges,
  personas,
  readOnly = false,
  onGraphChange,
  onNodeSelect,
  onApiChange,
}: OrchestraCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // ─── History ────────────────────────────────────────────
  const applySnapshot = useCallback(
    (snapshot: CanvasSnapshot) => {
      setNodes(snapshot.nodes as Node<PersonaNodeData>[]);
      setEdges(snapshot.edges);
      onGraphChange?.(snapshot.nodes as Node<PersonaNodeData>[], snapshot.edges);
    },
    [setNodes, setEdges, onGraphChange],
  );

  const { pushSnapshot, undo, redo, canUndo, canRedo } = useCanvasHistory(applySnapshot);

  const captureAndNotify = useCallback(
    (nextNodes: Node<PersonaNodeData>[], nextEdges: Edge[]) => {
      pushSnapshot({ nodes: nextNodes, edges: nextEdges });
      onGraphChange?.(nextNodes, nextEdges);
    },
    [pushSnapshot, onGraphChange],
  );

  // ─── Event handlers ────────────────────────────────────

  const handleNodesChange: OnNodesChange<Node<PersonaNodeData>> = useCallback(
    (changes) => {
      onNodesChange(changes);
      // Lightweight: don't snapshot on every position change — only on drag stop
    },
    [onNodesChange],
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
      const hasRemoval = changes.some((c) => c.type === 'remove');
      if (hasRemoval) {
        // Delay to let state settle, then snapshot
        setTimeout(() => {
          setNodes((n) => {
            setEdges((e) => {
              captureAndNotify(n as Node<PersonaNodeData>[], e);
              return e;
            });
            return n;
          });
        }, 0);
      }
    },
    [onEdgesChange, setNodes, setEdges, captureAndNotify],
  );

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      if (wouldCreateCycle(edges, connection.source, connection.target)) return;

      setEdges((eds) => {
        const newEdges = addEdge(
          { ...connection, id: nextEdgeId(), type: 'default', ...defaultEdgeOptions },
          eds,
        );
        setNodes((n) => {
          captureAndNotify(n as Node<PersonaNodeData>[], newEdges);
          return n;
        });
        return newEdges;
      });
    },
    [edges, setEdges, setNodes, captureAndNotify],
  );

  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node) => {
      setNodes((n) => {
        setEdges((e) => {
          captureAndNotify(n as Node<PersonaNodeData>[], e);
          return e;
        });
        return n;
      });
    },
    [setNodes, setEdges, captureAndNotify],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onNodeSelect?.(node.id);
    },
    [onNodeSelect],
  );

  const handlePaneClick = useCallback(() => {
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  // ─── Drag & Drop (from NodeLibrary) ────────────────────

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const personaId = event.dataTransfer.getData('application/orchestra-persona-id');
      if (!personaId) return;

      const persona = personas.find((p) => p.id === personaId);
      if (!persona) return;

      const bounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!bounds) return;

      const position = {
        x: event.clientX - bounds.left - 100,
        y: event.clientY - bounds.top - 50,
      };

      const newNode: Node<PersonaNodeData> = {
        id: nextNodeId(),
        type: 'persona',
        position,
        data: {
          personaId: persona.id,
          personaName: persona.name,
          personaEmoji: persona.emoji,
          label: persona.name,
          skillIds: [],
          isStartNode: nodes.length === 0,
          routing: undefined,
        },
      };

      setNodes((nds) => {
        const next = [...nds, newNode] as Node<PersonaNodeData>[];
        setEdges((eds) => {
          captureAndNotify(next, eds);
          return eds;
        });
        return next;
      });
    },
    [personas, nodes.length, setNodes, setEdges, captureAndNotify],
  );

  // ─── Keyboard shortcuts ────────────────────────────────

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (readOnly) return;
      const isCtrl = event.ctrlKey || event.metaKey;
      if (isCtrl && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo({ nodes, edges });
      } else if (isCtrl && event.key === 'z' && event.shiftKey) {
        event.preventDefault();
        redo({ nodes, edges });
      } else if (isCtrl && event.key === 'y') {
        event.preventDefault();
        redo({ nodes, edges });
      }
    },
    [readOnly, undo, redo, nodes, edges],
  );

  // ─── Public imperative methods via ref ─────────────────

  const applyAutoLayout = useCallback(
    (layoutFn: (nodes: Node<PersonaNodeData>[], edges: Edge[]) => Node<PersonaNodeData>[]) => {
      setNodes((n) => {
        const laid = layoutFn(n as Node<PersonaNodeData>[], edges);
        setEdges((e) => {
          captureAndNotify(laid, e);
          return e;
        });
        return laid;
      });
    },
    [edges, setNodes, setEdges, captureAndNotify],
  );

  const deleteSelectedNodes = useCallback(() => {
    setNodes((nds) => {
      const selected = nds.filter((n) => n.selected);
      if (selected.length === 0) return nds;
      const selectedIds = new Set(selected.map((n) => n.id));
      const remaining = nds.filter((n) => !selectedIds.has(n.id));
      setEdges((eds) => {
        const remainingEdges = eds.filter(
          (e) => !selectedIds.has(e.source) && !selectedIds.has(e.target),
        );
        captureAndNotify(remaining as Node<PersonaNodeData>[], remainingEdges);
        return remainingEdges;
      });
      return remaining;
    });
  }, [setNodes, setEdges, captureAndNotify]);

  // ─── Context value exposed to parent ───────────────────

  const canvasApi = useMemo(
    () => ({
      applyAutoLayout,
      deleteSelectedNodes,
      undo: () => undo({ nodes, edges }),
      redo: () => redo({ nodes, edges }),
      canUndo,
      canRedo,
      getNodes: () => nodes as Node<PersonaNodeData>[],
      getEdges: () => edges,
    }),
    [applyAutoLayout, deleteSelectedNodes, undo, redo, canUndo, canRedo, nodes, edges],
  );

  useEffect(() => {
    onApiChange?.(canvasApi);
  }, [canvasApi, onApiChange]);

  // ─── Render ────────────────────────────────────────────

  return (
    <div
      ref={reactFlowWrapper}
      className="orchestra-canvas"
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={readOnly ? undefined : handleNodesChange}
        onEdgesChange={readOnly ? undefined : handleEdgesChange}
        onConnect={readOnly ? undefined : handleConnect}
        onNodeDragStop={readOnly ? undefined : handleNodeDragStop}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onDragOver={readOnly ? undefined : handleDragOver}
        onDrop={readOnly ? undefined : handleDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        colorMode="dark"
        fitView
        deleteKeyCode={readOnly ? null : 'Delete'}
        multiSelectionKeyCode="Shift"
        snapToGrid
        snapGrid={[20, 20]}
        minZoom={0.2}
        maxZoom={2}
      >
        <Controls showInteractive={!readOnly} />
        <MiniMap
          nodeStrokeWidth={3}
          pannable
          zoomable
        />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}

export type OrchestraCanvasApi = {
  applyAutoLayout: (layoutFn: (nodes: Node<PersonaNodeData>[], edges: Edge[]) => Node<PersonaNodeData>[]) => void;
  deleteSelectedNodes: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  getNodes: () => Node<PersonaNodeData>[];
  getEdges: () => Edge[];
};
