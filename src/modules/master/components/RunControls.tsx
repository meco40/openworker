import React, { useEffect, useState } from 'react';
import type { MasterRun, ApprovalDecision } from '@/modules/master/types';
import { RunStatusBadge } from './RunStatusBadge';
import { ApprovalDecisionForm } from './ApprovalDecisionForm';

interface RunControlsProps {
  selectedRun: MasterRun | null;
  loading: boolean;
  onStartRun: (runId: string) => void;
  onExportRun: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  onSubmitDecision: (actionType: string, decision: ApprovalDecision) => void;
}

export const RunControls: React.FC<RunControlsProps> = ({
  selectedRun,
  loading,
  onStartRun,
  onExportRun,
  onCancelRun,
  onSubmitDecision,
}) => {
  const [cancelPending, setCancelPending] = useState(false);

  // Reset confirm dialog when the selected run changes
  useEffect(() => {
    setCancelPending(false);
  }, [selectedRun?.id]);

  const isFinished =
    selectedRun?.status === 'COMPLETED' ||
    selectedRun?.status === 'CANCELLED' ||
    selectedRun?.status === 'FAILED';

  const canStart =
    !!selectedRun && (selectedRun.status === 'IDLE' || selectedRun.status === 'FAILED');

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
              disabled={loading || !canStart}
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
            {/* Cancel – only for non-finished runs */}
            {!isFinished && !cancelPending && (
              <button
                type="button"
                onClick={() => setCancelPending(true)}
                disabled={loading}
                className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300 transition-all hover:bg-rose-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel Run
              </button>
            )}
            {!isFinished && cancelPending && (
              <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2">
                <span className="text-xs text-rose-300">Confirm cancel?</span>
                <button
                  type="button"
                  onClick={() => {
                    setCancelPending(false);
                    onCancelRun(selectedRun.id);
                  }}
                  disabled={loading}
                  className="rounded-lg bg-rose-600 px-2 py-1 text-[10px] font-bold text-white transition-all hover:bg-rose-500 disabled:opacity-50"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setCancelPending(false)}
                  className="rounded-lg border border-zinc-700 px-2 py-1 text-[10px] font-bold text-zinc-400 transition-all hover:bg-zinc-800"
                >
                  No
                </button>
              </div>
            )}
          </div>

          {/* Approval form – only when paused for approval */}
          {selectedRun.pausedForApproval && (
            <ApprovalDecisionForm
              pendingActionType={selectedRun.pendingApprovalActionType}
              loading={loading}
              onSubmit={onSubmitDecision}
            />
          )}
        </div>
      )}
    </section>
  );
};
