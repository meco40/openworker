'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/server/automation/flowTypes';

export function TriggerNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as FlowNodeData;
  const isCron = (data.config as { cronExpression?: string }).cronExpression;
  const isWebhook = (data.config as { webhookPath?: string }).webhookPath !== undefined;
  const icon = isCron ? '⏰' : isWebhook ? '🔗' : '▶️';

  return (
    <div
      className={`min-w-[160px] rounded-lg border-2 bg-zinc-900 px-4 py-3 shadow-lg ${
        selected ? 'border-violet-500' : 'border-violet-800/60'
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-bold tracking-widest text-violet-400 uppercase">Trigger</span>
      </div>
      <div className="text-sm font-semibold text-white">{data.label}</div>
      {isCron && (
        <div className="mt-1 rounded bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
          {String((data.config as { cronExpression: string }).cronExpression)}
        </div>
      )}
      {/* No input handle — this is the start node */}
      <Handle type="source" position={Position.Bottom} className="!bg-violet-500" />
    </div>
  );
}
