'use client';
import React from 'react';
import { NODE_PALETTE } from '@/modules/flow-builder/types';
import type { FlowNodeType } from '@/server/automation/flowTypes';

interface NodePaletteProps {
  onAddNode: (type: FlowNodeType, label: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  trigger: 'Triggers',
  condition: 'Conditions',
  action: 'Actions',
};

const CATEGORY_ORDER = ['trigger', 'condition', 'action'];

export function NodePalette({ onAddNode }: NodePaletteProps) {
  const grouped = NODE_PALETTE.reduce<Record<string, typeof NODE_PALETTE>>((acc, item) => {
    const cat = item.type.split('.')[0];
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  return (
    <aside className="flex w-44 flex-shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3">
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Nodes</p>
      {CATEGORY_ORDER.map((cat) => {
        const items = grouped[cat];
        if (!items?.length) return null;
        return (
          <div key={cat}>
            <p className="mb-1 text-[9px] font-bold tracking-widest text-zinc-600 uppercase">
              {CATEGORY_LABELS[cat] ?? cat}
            </p>
            <div className="flex flex-col gap-1">
              {items.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => onAddNode(item.type, item.label)}
                  className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-xs text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800"
                >
                  <span>{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
