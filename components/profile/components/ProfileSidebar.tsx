'use client';

import React from 'react';

export const ProfileSidebar: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="rounded-[2.5rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
        <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Data Scope
        </h4>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <span className="text-xs text-zinc-400">Personal Data</span>
            <span className="text-[9px] font-black text-emerald-500 uppercase">Local</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <span className="text-xs text-zinc-400">Workspace History</span>
            <span className="text-[9px] font-black text-indigo-400 uppercase">Local</span>
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <span className="text-xs text-zinc-400">Prompt Library</span>
            <span className="text-[9px] font-black text-zinc-600 uppercase">Local Only</span>
          </div>
        </div>
      </div>

      <div className="rounded-[2.5rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
        <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
          Security Tokens
        </h4>
        <div className="space-y-4">
          <button className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-900 hover:text-white">
            Manage API Keys
          </button>
          <button className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-900 hover:text-white">
            Audit Logs
          </button>
        </div>
      </div>
    </div>
  );
};
