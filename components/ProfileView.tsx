
import React from 'react';

const ProfileView: React.FC = () => {
  return (
    <div className="max-w-6xl space-y-10 animate-in fade-in duration-500 mx-auto pb-20">
      <header>
        <h2 className="text-3xl font-black text-white tracking-tight uppercase">SaaS Identity & Billing</h2>
        <p className="text-sm text-zinc-500 mt-1">Manage your multi-tenant organization, subscription plan, and operator profile.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        {/* Profile Card */}
        <div className="lg:col-span-2 space-y-8">
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-[2.5rem] p-10 flex flex-col md:flex-row gap-10 items-start shadow-2xl">
            <div className="flex flex-col items-center space-y-4 shrink-0">
              <div className="w-40 h-40 rounded-[2rem] bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white text-6xl font-black shadow-[0_0_50px_rgba(79,70,229,0.3)]">
                C
              </div>
              <button className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 uppercase tracking-widest transition-colors">Update Avatar</button>
            </div>

            <div className="flex-1 space-y-6 w-full">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Display Name</label>
                  <input type="text" defaultValue="OpenClaw Operator" className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-all" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Global UUID</label>
                  <input type="text" readOnly value="OC-F92-88-ALPHA" className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-sm text-zinc-500 font-mono cursor-not-allowed" />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Primary Contact</label>
                <input type="email" defaultValue="operator@openclaw.io" className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-sm text-white focus:outline-none focus:border-indigo-500 transition-all" />
              </div>

              <div className="pt-6 border-t border-zinc-800 flex space-x-4">
                <button className="flex-1 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-indigo-600/20 active:scale-95">
                  Save Changes
                </button>
                <button className="px-8 py-4 bg-zinc-900 hover:bg-rose-900/20 text-zinc-400 hover:text-rose-500 rounded-2xl text-[10px] font-black uppercase tracking-widest border border-zinc-800 hover:border-rose-500/30 transition-all">
                  Sign Out
                </button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900/40 border border-zinc-800 rounded-[2.5rem] p-10 space-y-8 shadow-2xl relative overflow-hidden">
             <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-[80px] -mr-32 -mt-32" />
             <h3 className="text-xl font-black text-white uppercase tracking-tight relative">Subscription & Usage</h3>
             
             <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
                <div className="p-6 bg-zinc-950/50 border border-zinc-800 rounded-2xl space-y-2">
                  <div className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Active Plan</div>
                  <div className="text-xl font-bold text-emerald-500">PRO_NODE</div>
                </div>
                <div className="p-6 bg-zinc-950/50 border border-zinc-800 rounded-2xl space-y-2">
                  <div className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Workspaces</div>
                  <div className="text-xl font-bold text-white">12 / 50</div>
                </div>
                <div className="p-6 bg-zinc-950/50 border border-zinc-800 rounded-2xl space-y-2">
                  <div className="text-[9px] font-black text-zinc-600 uppercase tracking-widest">Monthly Credits</div>
                  <div className="text-xl font-bold text-indigo-400">82% REM</div>
                </div>
             </div>
             
             <button className="w-full py-5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-2xl text-[10px] font-black uppercase tracking-widest border border-zinc-800 transition-all">
               Upgrade to Enterprise Node
             </button>
          </div>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
           <div className="bg-zinc-900/60 border border-zinc-800 rounded-[2.5rem] p-8 shadow-xl">
              <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-6">Cloud Synchronization</h4>
              <div className="space-y-4">
                 <div className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-2xl">
                    <span className="text-xs text-zinc-400">Personal Data</span>
                    <span className="text-[9px] font-black text-emerald-500 uppercase">Synced</span>
                 </div>
                 <div className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-2xl">
                    <span className="text-xs text-zinc-400">Workspace History</span>
                    <span className="text-[9px] font-black text-indigo-400 uppercase">Shared</span>
                 </div>
                 <div className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-2xl">
                    <span className="text-xs text-zinc-400">Prompt Library</span>
                    <span className="text-[9px] font-black text-zinc-600 uppercase">Local Only</span>
                 </div>
              </div>
           </div>

           <div className="bg-zinc-900/60 border border-zinc-800 rounded-[2.5rem] p-8 shadow-xl">
              <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-6">Security Tokens</h4>
              <div className="space-y-4">
                <button className="w-full py-4 bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">Manage API Keys</button>
                <button className="w-full py-4 bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">Audit Logs</button>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default ProfileView;
