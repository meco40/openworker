
import React from 'react';

const ExposureManager: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Remote Exposure</h2>
          <p className="text-sm text-zinc-500">Expose your local gateway safely to the internet via Tailscale or SSH.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A10.003 10.003 0 0012 3v8h8a9.99 9.99 0 01-2.247 6.325l-.056.088m-11.411-2.043L6.5 15.01" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white">Tailscale Funnel</h3>
              <p className="text-xs text-zinc-500 uppercase tracking-widest font-mono">Status: Enabled (Serve)</p>
            </div>
          </div>
          
          <div className="space-y-4">
            <div className="p-3 bg-zinc-950 border border-zinc-800 rounded">
              <div className="text-[10px] text-zinc-600 uppercase mb-1">Public URL</div>
              <div className="text-sm font-mono text-indigo-400">claw-gw.tail6381.ts.net</div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Expose Control UI</span>
              <div className="w-10 h-5 bg-indigo-600 rounded-full relative">
                <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Expose WebChat</span>
              <div className="w-10 h-5 bg-indigo-600 rounded-full relative">
                <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full" />
              </div>
            </div>
          </div>
          <button className="w-full mt-6 py-2 bg-rose-900/20 text-rose-500 border border-rose-900/30 rounded text-xs font-bold hover:bg-rose-900/30 transition-all uppercase tracking-widest">
            Stop All Funnels
          </button>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-500">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-white">SSH Tunneling</h3>
              <p className="text-xs text-zinc-500 uppercase tracking-widest font-mono">Status: Idle</p>
            </div>
          </div>
          <p className="text-sm text-zinc-500 mb-6">Connect to a remote VPS or through Ngrok-style tunnels for temporary development exposure.</p>
          <div className="space-y-3">
            <input 
              type="text" 
              placeholder="user@remote-host.com"
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-xs text-white focus:outline-none focus:border-indigo-500"
            />
            <button className="w-full py-2 bg-zinc-800 text-zinc-400 border border-zinc-700 rounded text-xs font-bold hover:bg-zinc-700 hover:text-white transition-all uppercase tracking-widest">
              Establish Remote Link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExposureManager;
