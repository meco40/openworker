'use client';

import React from 'react';

const MissionControlView: React.FC = () => {
  return (
    <div className="h-[calc(100vh-9rem)] min-h-[640px] overflow-hidden rounded-xl border border-zinc-800 bg-[#0a0a0a]">
      <iframe
        src="/mission-control"
        title="Mission Control"
        className="h-full w-full border-0"
        loading="lazy"
      />
    </div>
  );
};

export default MissionControlView;
