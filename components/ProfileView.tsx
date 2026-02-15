import React from 'react';

const ProfileView: React.FC = () => {
  return (
    <div className="animate-in fade-in mx-auto max-w-6xl space-y-10 pb-20 duration-500">
      <header>
        <h2 className="text-3xl font-black tracking-tight text-white uppercase">
          SaaS Identity & Billing
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your operator profile, subscription plan, and runtime settings.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        {/* Profile Card */}
        <div className="space-y-8 lg:col-span-2">
          <div className="flex flex-col items-start gap-10 rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl md:flex-row">
            <div className="flex shrink-0 flex-col items-center space-y-4">
              <div className="flex h-40 w-40 items-center justify-center rounded-[2rem] bg-gradient-to-br from-indigo-600 to-violet-700 text-6xl font-black text-white shadow-[0_0_50px_rgba(79,70,229,0.3)]">
                C
              </div>
              <button className="text-[10px] font-black tracking-widest text-indigo-400 uppercase transition-colors hover:text-indigo-300">
                Update Avatar
              </button>
            </div>

            <div className="w-full flex-1 space-y-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    Display Name
                  </label>
                  <input
                    type="text"
                    defaultValue="OpenClaw Operator"
                    className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                    Global UUID
                  </label>
                  <input
                    type="text"
                    readOnly
                    value="OC-F92-88-ALPHA"
                    className="w-full cursor-not-allowed rounded-2xl border border-zinc-800 bg-zinc-900 p-4 font-mono text-sm text-zinc-500"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Primary Contact
                </label>
                <input
                  type="email"
                  defaultValue="operator@openclaw.io"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex space-x-4 border-t border-zinc-800 pt-6">
                <button className="flex-1 rounded-2xl bg-indigo-600 py-4 text-[10px] font-black tracking-widest text-white uppercase shadow-xl shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95">
                  Save Changes
                </button>
                <button className="rounded-2xl border border-zinc-800 bg-zinc-900 px-8 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:border-rose-500/30 hover:bg-rose-900/20 hover:text-rose-500">
                  Sign Out
                </button>
              </div>
            </div>
          </div>

          <div className="relative space-y-8 overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
            <div className="absolute top-0 right-0 -mt-32 -mr-32 h-64 w-64 rounded-full bg-emerald-500/5 blur-[80px]" />
            <h3 className="relative text-xl font-black tracking-tight text-white uppercase">
              Subscription & Usage
            </h3>

            <div className="relative grid grid-cols-1 gap-6 md:grid-cols-3">
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Active Plan
                </div>
                <div className="text-xl font-bold text-emerald-500">PRO_NODE</div>
              </div>
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Workspaces
                </div>
                <div className="text-xl font-bold text-white">12 / 50</div>
              </div>
              <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
                <div className="text-[9px] font-black tracking-widest text-zinc-600 uppercase">
                  Monthly Credits
                </div>
                <div className="text-xl font-bold text-indigo-400">82% REM</div>
              </div>
            </div>

            <button className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 py-5 text-[10px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:bg-zinc-800">
              Upgrade to Enterprise Node
            </button>
          </div>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <div className="rounded-[2.5rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-xl">
            <h4 className="mb-6 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Cloud Synchronization
            </h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <span className="text-xs text-zinc-400">Personal Data</span>
                <span className="text-[9px] font-black text-emerald-500 uppercase">Synced</span>
              </div>
              <div className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <span className="text-xs text-zinc-400">Workspace History</span>
                <span className="text-[9px] font-black text-indigo-400 uppercase">Shared</span>
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
      </div>
    </div>
  );
};

export default ProfileView;
