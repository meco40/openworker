'use client';

import { useCallback, useEffect, useState } from 'react';
import { useNodesState, useEdgesState, addEdge } from '@xyflow/react';
import type { Connection } from '@xyflow/react';
import type { FlowBuilderNode, FlowBuilderEdge } from '@/modules/flow-builder/types';
import type { FlowGraph, FlowNodeData, FlowNodeType } from '@/server/automation/flowTypes';
import { createId } from '@/shared/lib/ids';

function graphToReactFlow(graph: FlowGraph): {
  nodes: FlowBuilderNode[];
  edges: FlowBuilderEdge[];
} {
  return {
    nodes: graph.nodes.map((n) => ({ ...n, type: n.type as FlowNodeType })) as FlowBuilderNode[],
    edges: graph.edges as FlowBuilderEdge[],
  };
}

function reactFlowToGraph(nodes: FlowBuilderNode[], edges: FlowBuilderEdge[]): FlowGraph {
  return {
    version: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as FlowNodeType,
      position: n.position,
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      label: typeof e.label === 'string' ? e.label : undefined,
    })),
  };
}

export function useFlowEditor(ruleId: string) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowBuilderNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowBuilderEdge>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Load on mount — with proper error handling
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/automations/${ruleId}/flow`)
      .then(async (r) => {
        const data = (await r.json()) as {
          ok: boolean;
          flowGraph: FlowGraph | null;
          error?: string;
        };
        if (cancelled) return;
        if (!data.ok) {
          setLoadError(data.error ?? 'Failed to load flow');
          return;
        }
        if (data.flowGraph) {
          const { nodes: n, edges: e } = graphToReactFlow(data.flowGraph);
          setNodes(n);
          setEdges(e);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Network error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ruleId, setNodes, setEdges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, id: createId('edge') }, eds));
      setIsDirty(true);
    },
    [setEdges],
  );

  const addNode = useCallback(
    (
      type: FlowNodeType,
      position: { x: number; y: number },
      defaultConfig: Record<string, unknown>,
    ) => {
      const newNode: FlowBuilderNode = {
        id: createId('node'),
        type,
        position,
        data: { label: type.split('.')[1] ?? type, config: defaultConfig },
      };
      setNodes((nds) => [...nds, newNode]);
      setIsDirty(true);
    },
    [setNodes],
  );

  const updateNodeData = useCallback(
    (nodeId: string, patch: Partial<FlowNodeData>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
      setIsDirty(true);
    },
    [setNodes],
  );

  const saveFlow = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const graph = reactFlowToGraph(nodes, edges);
      const res = await fetch(`/api/automations/${ruleId}/flow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowGraph: graph }),
      });
      const data = (await res.json()) as { ok: boolean; errors?: { message: string }[] };
      if (!data.ok) {
        setSaveError(data.errors?.map((e) => e.message).join(', ') ?? 'Save failed');
      } else {
        setIsDirty(false);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [ruleId, nodes, edges]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    updateNodeData,
    saveFlow,
    saving,
    saveError,
    loadError,
    isDirty,
  };
}
