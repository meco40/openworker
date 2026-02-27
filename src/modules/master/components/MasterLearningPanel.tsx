import React from 'react';

const MasterLearningPanel: React.FC = () => {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="text-sm font-semibold tracking-wide text-zinc-200 uppercase">Learning Loop</h3>
      <p className="mt-2 text-sm text-zinc-400">
        Geplanter Lernlauf taeglich um 03:00 (Serverzeit), preemptible und budgetbegrenzt.
      </p>
    </section>
  );
};

export default MasterLearningPanel;
