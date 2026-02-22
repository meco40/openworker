'use client';
import React from 'react';
import { ReactFlow, Background, Controls, MiniMap, BackgroundVariant } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  NodeMouseHandler,
  NodeTypes,
} from '@xyflow/react';
import type { FlowBuilderNode, FlowBuilderEdge } from '@/modules/flow-builder/types';
import { TriggerNode } from '@/modules/flow-builder/nodes/TriggerNode';
import { ConditionNode } from '@/modules/flow-builder/nodes/ConditionNode';
import { SkillNode } from '@/modules/flow-builder/nodes/SkillNode';
import { PromptNode } from '@/modules/flow-builder/nodes/PromptNode';
import { ChannelActionNode } from '@/modules/flow-builder/nodes/ChannelActionNode';

const NODE_TYPES: NodeTypes = {
  'trigger.cron': TriggerNode,
  'trigger.manual': TriggerNode,
  'trigger.webhook': TriggerNode,
  'condition.filter': ConditionNode,
  'condition.ai_classifier': ConditionNode,
  'condition.regex': ConditionNode,
  'action.run_prompt': PromptNode,
  'action.skill': SkillNode,
  'action.send_message': ChannelActionNode,
  'action.notify': ChannelActionNode,
};

interface FlowEditorCanvasProps {
  nodes: FlowBuilderNode[];
  edges: FlowBuilderEdge[];
  onNodesChange: OnNodesChange<FlowBuilderNode>;
  onEdgesChange: OnEdgesChange<FlowBuilderEdge>;
  onConnect: OnConnect;
  onNodeClick: NodeMouseHandler<FlowBuilderNode>;
}

export function FlowEditorCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
}: FlowEditorCanvasProps) {
  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={NODE_TYPES}
        fitView
        className="bg-zinc-950"
      >
        <Background variant={BackgroundVariant.Dots} color="#27272a" />
        <Controls className="!border-zinc-700 !bg-zinc-900" />
        <MiniMap
          className="!border-zinc-700 !bg-zinc-900"
          nodeColor={(n) =>
            n.type?.startsWith('trigger.')
              ? '#7c3aed'
              : n.type?.startsWith('condition.')
                ? '#b45309'
                : '#059669'
          }
        />
      </ReactFlow>
    </div>
  );
}
