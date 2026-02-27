import React from 'react';
import MasterLearningPanel from '@/modules/master/components/MasterLearningPanel';

const MasterView: React.FC = () => {
  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-lg font-semibold text-zinc-100">Master</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Autonomer Control-Plane-Agent mit Delegation, Approval-Gates und Lernzyklen.
        </p>
      </header>
      <MasterLearningPanel />
    </section>
  );
};

export default MasterView;
