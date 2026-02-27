import React from 'react';

interface MasterLearningPanelProps {
  metrics?: Record<string, unknown> | null;
}

const MasterLearningPanel: React.FC<MasterLearningPanelProps> = ({ metrics }) => {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="text-sm font-semibold tracking-wide text-zinc-200 uppercase">Learning Loop</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Geplanter Lernlauf taeglich um 03:00 (Serverzeit), preemptible und budgetbegrenzt.
      </p>
      <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2">
        <div className="rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1.5">
          learning_cycle_success_rate:{' '}
          {metrics?.learning_cycle_success_rate !== undefined
            ? Number(metrics.learning_cycle_success_rate).toFixed(2)
            : 'n/a'}
        </div>
        <div className="rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1.5">
          tool_forge_success_rate:{' '}
          {metrics?.tool_forge_success_rate !== undefined
            ? Number(metrics.tool_forge_success_rate).toFixed(2)
            : 'n/a'}
        </div>
      </div>
    </section>
  );
};

export default MasterLearningPanel;
