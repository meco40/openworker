import React from 'react';

interface AppShellHeaderProps {
  pendingTaskCount: number;
  memoryEntryCount: number;
}

const AppShellHeader: React.FC<AppShellHeaderProps> = ({ pendingTaskCount, memoryEntryCount }) => {
  return (
    <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-[#0c0c0c] z-10">
      <div className="flex items-center space-x-4">
        <h1 className="text-lg font-bold text-white tracking-tight">OpenClaw Gateway</h1>
        <div className="px-2 py-0.5 rounded border border-violet-500/30 bg-violet-500/5 text-[9px] font-black text-violet-400 uppercase tracking-widest">
          Active Bridge Node
        </div>
      </div>
      <div className="flex items-center space-x-6">
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Active Crons</div>
          <div className="text-emerald-500 font-mono font-bold">{pendingTaskCount}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-600 uppercase">Vector DB</div>
          <div className="text-zinc-300 font-mono">{memoryEntryCount}</div>
        </div>
      </div>
    </header>
  );
};

export default AppShellHeader;
