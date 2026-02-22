'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/server/automation/flowTypes';

export function PromptNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as FlowNodeData;
  const prompt = String((data.config as { prompt?: string }).prompt ?? '');
  return (
    <div
      className={`min-w-[180px] rounded-lg border-2 bg-zinc-900 px-4 py-3 shadow-lg ${
        selected ? 'border-emerald-500' : 'border-emerald-800/60'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm">💬</span>
        <span className="text-xs font-bold tracking-widest text-emerald-400 uppercase">
          AI Prompt
        </span>
      </div>
      <div className="text-sm font-semibold text-white">{data.label}</div>
      {prompt && <div className="mt-1 line-clamp-2 text-[10px] text-zinc-400">{prompt}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-500" />
    </div>
  );
}
