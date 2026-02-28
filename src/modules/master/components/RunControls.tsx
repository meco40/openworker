import React from 'react';
import type { MasterRun, ApprovalDecision } from '@/modules/master/types';
import { RunStatusBadge } from './RunStatusBadge';
import { ApprovalDecisionForm } from './ApprovalDecisionForm';

interface RunControlsProps {
  selectedRun: MasterRun | null;
  loading: boolean;
  onStartRun: (runId: string) => void;
  onExportRun: (runId: string) => void;
  onSubmitDecision: (actionType: string, decision: ApprovalDecision) => void;
}

export const RunControls: React.FC<RunControlsProps> = ({
  selectedRun,
  loading,
  onStartRun,
  onExportRun,
  onSubmitDecision,
}) => {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Run Controls
      </h3>

      {!selectedRun ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-600">
          Select a run to see controls.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Run info */}
          <div className="space-y-2 rounded-xl border border-zinc-700 bg-zinc-950/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-zinc-500">Status</span>
              <RunStatusBadge status={selectedRun.status} size="sm" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-zinc-500">Progress</span>
              <span className="font-mono text-[10px] text-zinc-300">{selectedRun.progress}%</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-zinc-500">Paused for approval</span>
              <span
                className={`font-mono text-[10px] ${selectedRun.pausedForApproval ? 'text-amber-300' : 'text-zinc-500'}`}
              >
                {selectedRun.pausedForApproval ? 'yes' : 'no'}
              </span>
            </div>
            {selectedRun.lastError && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-2 py-1.5">
                <p className="font-mono text-[10px] text-rose-300">{selectedRun.lastError}</p>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onStartRun(selectedRun.id)}
              disabled={loading}
              className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Run
            </button>
            <button
              type="button"
              onClick={() => onExportRun(selectedRun.id)}
              disabled={loading}
              className="rounded-xl border border-zinc-600 bg-zinc-950 px-3 py-2 text-xs font-bold text-zinc-200 transition-all hover:bg-zinc-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export Bundle
            </button>
          </div>

          {/* Approval form – only when paused for approval */}
          {selectedRun.pausedForApproval && (
            <ApprovalDecisionForm loading={loading} onSubmit={onSubmitDecision} />
          )}
        </div>
      )}
    </section>
  );
};
