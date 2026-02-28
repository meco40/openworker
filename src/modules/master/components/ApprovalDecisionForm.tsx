import React, { useEffect, useState } from 'react';
import type { ApprovalDecision } from '@/modules/master/types';
import { KNOWN_ACTION_TYPES } from '@/modules/master/types';

interface ApprovalDecisionFormProps {
  loading: boolean;
  pendingActionType?: string | null;
  onSubmit: (actionType: string, decision: ApprovalDecision) => void;
}

export const ApprovalDecisionForm: React.FC<ApprovalDecisionFormProps> = ({
  loading,
  pendingActionType,
  onSubmit,
}) => {
  const [actionType, setActionType] = useState<string>(pendingActionType ?? KNOWN_ACTION_TYPES[0]);
  const [decision, setDecision] = useState<ApprovalDecision>('approve_once');

  // Sync actionType whenever pendingActionType changes (including reset to default when cleared)
  useEffect(() => {
    setActionType(pendingActionType ?? KNOWN_ACTION_TYPES[0]);
  }, [pendingActionType]);

  return (
    <div className="overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/5">
      {/* Approval header */}
      <div className="flex items-center gap-2.5 border-b border-amber-500/15 bg-amber-500/5 px-4 py-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/20">
          <svg
            className="h-3.5 w-3.5 text-amber-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
        </div>
        <h4 className="text-[10px] font-bold tracking-widest text-amber-300 uppercase">
          Approval Required
        </h4>
        <span
          className="ml-auto flex h-2 w-2 animate-pulse rounded-full bg-amber-400"
          aria-hidden="true"
        />
      </div>

      <div className="space-y-3 p-4">
        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Action Type
          </label>
          {pendingActionType ? (
            <div className="w-full rounded-xl border border-amber-500/20 bg-zinc-950/60 px-3 py-2.5 font-mono text-sm font-semibold text-amber-300">
              {pendingActionType}
            </div>
          ) : (
            <select
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 focus:outline-none"
            >
              {KNOWN_ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
            Decision
          </label>
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as ApprovalDecision)}
            className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 focus:outline-none"
          >
            <option value="approve_once">Approve Once</option>
            <option value="approve_always">Approve Always</option>
            <option value="deny">Deny</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => onSubmit(actionType, decision)}
          disabled={loading}
          className="w-full rounded-xl border border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-xs font-black tracking-wide text-amber-200 uppercase transition-all hover:bg-amber-500/25 hover:text-amber-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply Decision
        </button>
      </div>
    </div>
  );
};
