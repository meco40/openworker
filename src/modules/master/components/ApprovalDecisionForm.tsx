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
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <svg
          className="h-4 w-4 shrink-0 text-amber-400"
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
        <h4 className="text-xs font-bold tracking-widest text-amber-300 uppercase">
          Approval Required
        </h4>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1.5 text-xs text-zinc-400">
          <span>Action Type</span>
          {pendingActionType ? (
            <div className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 font-mono text-sm text-amber-300">
              {pendingActionType}
            </div>
          ) : (
            <select
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
            >
              {KNOWN_ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="block space-y-1.5 text-xs text-zinc-400">
          <span>Decision</span>
          <select
            value={decision}
            onChange={(e) => setDecision(e.target.value as ApprovalDecision)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
          >
            <option value="approve_once">Approve Once</option>
            <option value="approve_always">Approve Always</option>
            <option value="deny">Deny</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => onSubmit(actionType, decision)}
          disabled={loading}
          className="w-full rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-bold text-amber-200 transition-all hover:bg-amber-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply Decision
        </button>
      </div>
    </div>
  );
};
