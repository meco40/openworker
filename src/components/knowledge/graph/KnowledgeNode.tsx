'use client';

import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { KnowledgeFlowNodeData } from '@/components/knowledge/graph/types';

export function KnowledgeNode({ data, selected }: NodeProps & { data: KnowledgeFlowNodeData }) {
  const motionStyle: CSSProperties & Record<string, string> = {
    '--knowledge-drift-duration': `${data.motionDurationSeconds}s`,
    '--knowledge-drift-delay': `${data.motionDelaySeconds}s`,
    '--knowledge-drift-x': `${data.motionOffsetX}px`,
    '--knowledge-drift-y': `${data.motionOffsetY}px`,
  };

  return (
    <div
      className={`knowledge-node min-w-[110px] rounded-2xl border px-3 py-2 shadow-xl backdrop-blur-md transition-all ${
        data.motionEnabled ? 'knowledge-node--drift' : ''
      }`}
      style={{
        ...motionStyle,
        borderColor: data.color,
        background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.85))',
        boxShadow: selected
          ? `0 0 0 1px ${data.color}, 0 0 20px ${data.color}55`
          : `0 0 0 1px ${data.color}66, 0 10px 25px rgba(2,6,23,0.45)`,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ borderColor: data.color, background: '#0f172a' }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-slate-100">{data.label}</span>
        {data.showCategory ? (
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase"
            style={{ color: data.color, backgroundColor: `${data.color}22` }}
          >
            {data.category}
          </span>
        ) : null}
      </div>
      {data.showMeta ? (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
          <span>edges: {data.degree}</span>
          <span>aliases: {data.aliasCount}</span>
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        style={{ borderColor: data.color, background: '#0f172a' }}
      />
    </div>
  );
}
