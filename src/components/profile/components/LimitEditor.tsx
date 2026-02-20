'use client';

import React from 'react';

interface LimitEditorProps {
  workspaceSlots: number;
  dailyTokenBudget: number;
  isSaving: boolean;
  onUpdateWorkspaceSlots: (value: string) => void;
  onUpdateDailyTokenBudget: (value: string) => void;
}

export const LimitEditor: React.FC<LimitEditorProps> = ({
  workspaceSlots,
  dailyTokenBudget,
  isSaving,
  onUpdateWorkspaceSlots,
  onUpdateDailyTokenBudget,
}) => {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 md:grid-cols-2">
      <label className="space-y-2">
        <span className="text-[9px] font-black tracking-widest text-zinc-500 uppercase">
          Workspace Slot Limit
        </span>
        <input
          type="number"
          min={1}
          value={workspaceSlots}
          onChange={(event) => onUpdateWorkspaceSlots(event.target.value)}
          disabled={isSaving}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-60"
        />
      </label>
      <label className="space-y-2">
        <span className="text-[9px] font-black tracking-widest text-zinc-500 uppercase">
          Daily Token Budget
        </span>
        <input
          type="number"
          min={1}
          value={dailyTokenBudget}
          onChange={(event) => onUpdateDailyTokenBudget(event.target.value)}
          disabled={isSaving}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-60"
        />
      </label>
    </div>
  );
};
