import React from 'react';
import { View } from '../types';
import ConnectionStatus from './ConnectionStatus';

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  onToggleCanvas: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeView, onViewChange, onToggleCanvas }) => {
  const items = [
    { id: View.DASHBOARD, label: 'Control Plane', icon: 'M4 6h16M4 12h16M4 18h16' },
    {
      id: View.WORKER,
      label: 'Autonomous Worker',
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    },
    {
      id: View.TEAMS,
      label: 'Team Collaboration',
      icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
    },
    {
      id: View.MODELS,
      label: 'AI Model Hub',
      icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    },
    {
      id: View.CHANNELS,
      label: 'Messenger Coupling',
      icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    },
    {
      id: View.CHAT,
      label: 'Multi-Channel Inbox',
      icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z',
    },
    {
      id: View.SKILLS,
      label: 'Skill Registry',
      icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.673.337a4 4 0 01-1.909.408H9a1 1 0 011 1h3c1.33 0 2.427-.858 2.821-2.043l3.137-.891a1 1 0 011.237 1.213l-.367 1.467a2 2 0 01-2.034 1.492H15a2 2 0 00-2 2v1a2 2 0 01-2 2H8a2 2 0 01-2-2v-1a2 2 0 012-2h.586a1 1 0 01.707.293l.354.354A1 1 0 0010.354 13h1.293a1 1 0 00.707-.293l.354-.354a1 1 0 01.707-.293H15a2 2 0 012 2v.586a1 1 0 00.293.707l.354.354a1 1 0 001.414-1.414l-.354-.354a1 1 0 01-.293-.707V15a2 2 0 012-2h.586a1 1 0 00.707-.293l.354-.354a1 1 0 00-1.414-1.414l-.354.354z',
    },
    {
      id: View.TASKS,
      label: 'Task Monitor',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      id: View.LOGS,
      label: 'System Logs',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      id: View.STATS,
      label: 'Usage Stats',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      id: View.SECURITY,
      label: 'Security Panel',
      icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    },
    {
      id: View.CONFIG,
      label: 'Gateway Config',
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    },
    {
      id: View.PROFILE,
      label: 'SaaS Identity',
      icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    },
  ];

  return (
    <aside className="z-20 flex w-64 flex-col border-r border-zinc-800 bg-[#0c0c0c]">
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        <div className="mb-8 flex items-center space-x-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-gradient-to-br from-indigo-600 to-violet-700 text-xl font-black text-white">
            C
          </div>
          <span className="text-lg font-bold tracking-tight text-white">OpenClaw</span>
        </div>

        <nav className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`flex w-full items-center space-x-3 rounded-md px-3 py-2.5 text-sm transition-all duration-200 ${
                activeView === item.id
                  ? 'bg-zinc-800 text-white shadow-lg'
                  : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} />
              </svg>
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-8">
          <h4 className="mb-4 px-3 text-[10px] font-bold tracking-widest text-zinc-600 uppercase">
            Companion Apps
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
              <span className="text-xs text-zinc-400">macOS Node</span>
              <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            </div>
            <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 opacity-50">
              <span className="text-xs text-zinc-400">iOS Node</span>
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
            </div>
            <ConnectionStatus />
          </div>
        </div>
      </div>

      <div className="space-y-2 border-t border-zinc-800 bg-[#0c0c0c] p-4">
        <button
          onClick={onToggleCanvas}
          className="flex w-full items-center justify-center space-x-2 rounded bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-indigo-700"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          <span>LIVE CANVAS</span>
        </button>
        <div className="flex items-center justify-between px-2 pt-2 font-mono text-[10px] text-zinc-600 uppercase">
          <span>Node: Localhost</span>
          <span className="text-emerald-500">v1.2.4</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
