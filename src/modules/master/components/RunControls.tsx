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
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/15">
            <svg
              className="h-3.5 w-3.5 text-sky-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
            Run Controls
          </h3>
        </div>
      </div>

      <div className="p-4">
        {!selectedRun ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center">
            <svg
              className="mb-3 h-10 w-10 text-zinc-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5"
              />
            </svg>
            <p className="text-sm font-medium text-zinc-600">Select a run</p>
            <p className="mt-1 text-xs text-zinc-700">to see controls.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Run info */}
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
              <div className="divide-y divide-zinc-800/60">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="font-mono text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Status
                  </span>
                  <RunStatusBadge status={selectedRun.status} size="sm" />
                </div>
                <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="font-mono text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Progress
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                        style={{ width: `${selectedRun.progress}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] font-bold text-zinc-300 tabular-nums">
                      {selectedRun.progress}%
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="font-mono text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
                    Paused for approval
                  </span>
                  <span
                    className={`font-mono text-[10px] font-bold ${
                      selectedRun.pausedForApproval ? 'text-amber-300' : 'text-zinc-600'
                    }`}
                  >
                    {selectedRun.pausedForApproval ? 'YES' : 'no'}
                  </span>
                </div>
              </div>
              {selectedRun.lastError && (
                <div className="border-t border-rose-500/20 bg-rose-500/5 px-4 py-2.5">
                  <p className="font-mono text-[10px] leading-relaxed text-rose-300">
                    {selectedRun.lastError}
                  </p>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onStartRun(selectedRun.id)}
                disabled={loading || !canStart}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black tracking-wide text-white uppercase shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start Run
              </button>
              <button
                type="button"
                onClick={() => onExportRun(selectedRun.id)}
                disabled={loading}
                className="rounded-xl border border-zinc-600/80 bg-zinc-900 px-4 py-2 text-xs font-black tracking-wide text-zinc-200 uppercase transition-all hover:bg-zinc-800 hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Export Bundle
              </button>
              {/* Cancel – only for non-finished runs */}
              {!isFinished && !cancelPending && (
                <button
                  type="button"
                  onClick={() => setCancelPending(true)}
                  disabled={loading}
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs font-black tracking-wide text-rose-300 uppercase transition-all hover:bg-rose-500/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel Run
                </button>
              )}
              {!isFinished && cancelPending && (
                <div className="flex items-center gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3.5 py-2">
                  <span className="text-xs font-medium text-rose-300">Confirm cancel?</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCancelPending(false);
                      onCancelRun(selectedRun.id);
                    }}
                    disabled={loading}
                    className="rounded-lg bg-rose-600 px-2.5 py-1 text-[10px] font-bold text-white uppercase transition-all hover:bg-rose-500 disabled:opacity-50"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setCancelPending(false)}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1 text-[10px] font-bold text-zinc-400 uppercase transition-all hover:bg-zinc-800"
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
      </div>
    </section>
  );
};
