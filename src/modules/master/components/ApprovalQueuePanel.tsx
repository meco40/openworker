import React from 'react';
import type { ApprovalDecision, MasterApprovalRequest } from '@/modules/master/types';

interface ApprovalQueuePanelProps {
  approvals: MasterApprovalRequest[];
  loading: boolean;
  onDecide: (approvalRequestId: string, decision: ApprovalDecision) => void;
}

const DECISIONS: ApprovalDecision[] = ['approve_once', 'approve_always', 'deny'];

function decisionLabel(decision: ApprovalDecision): string {
  if (decision === 'approve_once') return 'Approve Once';
  if (decision === 'approve_always') return 'Approve Always';
  return 'Deny';
}

export function ApprovalQueuePanel({
  approvals,
  loading,
  onDecide,
}: ApprovalQueuePanelProps): React.ReactElement {
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Approval Queue
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              Pending tool actions that require an operator decision.
            </p>
          </div>
          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[10px] font-semibold text-amber-300">
            {pendingApprovals.length} pending
          </span>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {pendingApprovals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-500">
            No pending approvals.
          </div>
        ) : (
          pendingApprovals.map((approval) => (
            <article
              key={approval.id}
              className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{approval.summary}</p>
                  <p className="mt-1 font-mono text-[11px] text-zinc-500">
                    {approval.actionType} · {approval.toolName} · {approval.riskLevel}
                  </p>
                </div>
                <span className="rounded-full border border-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-400">
                  {approval.runId}
                </span>
              </div>
              <p className="mt-3 rounded-lg bg-zinc-900/70 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                {approval.prompt}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {DECISIONS.map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={loading}
                    onClick={() => onDecide(approval.id, decision)}
                    className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] font-bold tracking-wide text-zinc-200 uppercase transition hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {decisionLabel(decision)}
                  </button>
                ))}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
