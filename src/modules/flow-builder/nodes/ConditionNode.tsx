'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/server/automation/flowTypes';

export function ConditionNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as FlowNodeData;
  return (
    <div
      className={`min-w-[180px] rounded-lg border-2 bg-zinc-900 px-4 py-3 shadow-lg ${
        selected ? 'border-amber-500' : 'border-amber-800/60'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm">🔀</span>
        <span className="text-xs font-bold tracking-widest text-amber-400 uppercase">
          Condition
        </span>
      </div>
      <div className="text-sm font-semibold text-white">{data.label}</div>
      {/* True-Handle left, False-Handle right */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        style={{ left: '30%' }}
        className="!bg-emerald-500"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        style={{ left: '70%' }}
        className="!bg-rose-500"
      />
      <div className="mt-2 flex justify-between px-2 text-[9px] font-bold">
        <span className="text-emerald-400">TRUE</span>
        <span className="text-rose-400">FALSE</span>
      </div>
    </div>
  );
}
