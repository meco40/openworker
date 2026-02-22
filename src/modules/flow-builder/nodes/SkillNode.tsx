'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/server/automation/flowTypes';

const SKILL_ICONS: Record<string, string> = {
  search: '🔍',
  browser: '🌐',
  'python-runtime': '🐍',
  vision: '👁️',
  filesystem: '📁',
  'github-manager': '🐙',
  'shell-access': '💻',
  'sql-bridge': '🗄️',
  subagents: '🤖',
};

export function SkillNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as FlowNodeData;
  const skillId = String((data.config as { skillId?: string }).skillId ?? 'search');
  return (
    <div
      className={`min-w-[160px] rounded-lg border-2 bg-zinc-900 px-4 py-3 shadow-lg ${
        selected ? 'border-sky-500' : 'border-sky-800/60'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm">{SKILL_ICONS[skillId] ?? '⚡'}</span>
        <span className="text-xs font-bold tracking-widest text-sky-400 uppercase">Skill</span>
      </div>
      <div className="text-sm font-semibold text-white">{data.label}</div>
      <div className="mt-1 text-[10px] text-zinc-500">{skillId}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-sky-500" />
    </div>
  );
}
