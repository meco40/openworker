'use client';
import React, { useCallback, useState } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowEditor } from '@/modules/flow-builder/useFlowEditor';
import { FlowEditorCanvas } from '@/modules/flow-builder/components/FlowEditorCanvas';
import { NodePalette } from '@/modules/flow-builder/components/NodePalette';
import { NodeConfigPanel } from '@/modules/flow-builder/components/NodeConfigPanel';
import { FlowToolbar } from '@/modules/flow-builder/components/FlowToolbar';
import type { FlowNodeType } from '@/server/automation/flowTypes';
import type { FlowBuilderNode } from '@/modules/flow-builder/types';
import type { NodeMouseHandler } from '@xyflow/react';

interface FlowBuilderViewProps {
  ruleId: string;
  ruleName: string;
  onBack: () => void;
}

/** Inner component — must be mounted inside ReactFlowProvider to use useReactFlow() */
function FlowBuilderInner({ ruleId, ruleName, onBack }: FlowBuilderViewProps) {
  const { screenToFlowPosition } = useReactFlow();

  const {
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
  } = useFlowEditor(ruleId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode: FlowBuilderNode | undefined = nodes.find((n) => n.id === selectedNodeId);

  const handleNodeClick: NodeMouseHandler<FlowBuilderNode> = useCallback((_event, node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handlePaletteAdd = useCallback(
    (type: FlowNodeType, _label: string) => {
      // Place new node near the centre of the current viewport
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      addNode(type, position, {});
    },
    [screenToFlowPosition, addNode],
  );

  const handleConfigChange = useCallback(
    (nodeId: string, config: Record<string, unknown>) => {
      updateNodeData(nodeId, { config });
    },
    [updateNodeData],
  );

  const handleLabelChange = useCallback(
    (nodeId: string, label: string) => {
      updateNodeData(nodeId, { label });
    },
    [updateNodeData],
  );

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950">
        <p className="text-red-400">Failed to load flow graph</p>
        <p className="text-xs text-zinc-500">{loadError}</p>
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <FlowToolbar
        ruleName={ruleName}
        isDirty={isDirty}
        saving={saving}
        saveError={saveError}
        onSave={saveFlow}
        onBack={onBack}
      />
      <div className="flex flex-1 overflow-hidden">
        <NodePalette onAddNode={handlePaletteAdd} />
        <div className="flex-1">
          <FlowEditorCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={handleNodeClick}
          />
        </div>
        {selectedNode && (
          <NodeConfigPanel
            nodeId={selectedNode.id}
            nodeType={selectedNode.type as FlowNodeType}
            nodeLabel={selectedNode.data.label}
            config={selectedNode.data.config}
            onConfigChange={handleConfigChange}
            onLabelChange={handleLabelChange}
          />
        )}
      </div>
    </div>
  );
}

/** Public export — wraps inner component in ReactFlowProvider */
export function FlowBuilderView(props: FlowBuilderViewProps) {
  return (
    <ReactFlowProvider>
      <FlowBuilderInner {...props} />
    </ReactFlowProvider>
  );
}
