import React from 'react';

const ExposureManager: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Remote Exposure</h2>
          <p className="text-sm text-zinc-500">
            Expose your local gateway safely to the internet via Tailscale or SSH.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <div className="mb-6 flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-white">
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A10.003 10.003 0 0012 3v8h8a9.99 9.99 0 01-2.247 6.325l-.056.088m-11.411-2.043L6.5 15.01"
                />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white">Tailscale Funnel</h3>
              <p className="font-mono text-xs tracking-widest text-zinc-500 uppercase">
                Status: Enabled (Serve)
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
              <div className="mb-1 text-[10px] text-zinc-600 uppercase">Public URL</div>
              <div className="font-mono text-sm text-indigo-400">claw-gw.tail6381.ts.net</div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Expose Control UI</span>
              <div className="relative h-5 w-10 rounded-full bg-indigo-600">
                <div className="absolute top-1 right-1 h-3 w-3 rounded-full bg-white" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Expose WebChat</span>
              <div className="relative h-5 w-10 rounded-full bg-indigo-600">
                <div className="absolute top-1 right-1 h-3 w-3 rounded-full bg-white" />
              </div>
            </div>
          </div>
          <button className="mt-6 w-full rounded border border-rose-900/30 bg-rose-900/20 py-2 text-xs font-bold tracking-widest text-rose-500 uppercase transition-all hover:bg-rose-900/30">
            Stop All Funnels
          </button>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
          <div className="mb-6 flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white">SSH Tunneling</h3>
              <p className="font-mono text-xs tracking-widest text-zinc-500 uppercase">
                Status: Idle
              </p>
            </div>
          </div>
          <p className="mb-6 text-sm text-zinc-500">
            Connect to a remote VPS or through Ngrok-style tunnels for temporary development
            exposure.
          </p>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="user@remote-host.com"
              className="w-full rounded border border-zinc-800 bg-zinc-950 p-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            />
            <button className="w-full rounded border border-zinc-700 bg-zinc-800 py-2 text-xs font-bold tracking-widest text-zinc-400 uppercase transition-all hover:bg-zinc-700 hover:text-white">
              Establish Remote Link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExposureManager;
