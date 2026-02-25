import React, { useCallback } from 'react';
import { View } from '@/shared/domain/types';
import ConnectionStatus from '@/components/ConnectionStatus';

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
}

interface SidebarItem {
  id: View;
  label: string;
  icon: string;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: View.DASHBOARD, label: 'Control Plane', icon: 'M4 6h16M4 12h16M4 18h16' },
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
    id: View.PERSONAS,
    label: 'Agent Personas',
    icon: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z',
  },
  {
    id: View.MEMORY,
    label: 'Memory',
    icon: 'M9 7h6m-6 4h6m-8 8h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z',
  },
  {
    id: View.KNOWLEDGE,
    label: 'Knowledge',
    icon: 'M7 8h10M7 12h10M7 16h6M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  },
  {
    id: View.TASKS,
    label: 'Task Monitor',
    icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  },
  {
    id: View.MISSION_CONTROL,
    label: 'Mission Control',
    icon: 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-10h8V3h-8v8z',
  },
  { id: View.INSTANCES, label: 'Instances', icon: 'M4 7h16M4 12h16M4 17h16' },
  {
    id: View.SESSIONS,
    label: 'Sessions',
    icon: 'M8 7h8M6 3h12a1 1 0 011 1v16a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z',
  },
  {
    id: View.CRON,
    label: 'Cron',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    id: View.NODES,
    label: 'Nodes',
    icon: 'M5 12h14M12 5v14M3 7h4v4H3V7zm14 0h4v4h-4V7zM3 13h4v4H3v-4zm14 0h4v4h-4v-4z',
  },
  {
    id: View.AGENTS,
    label: 'Agents',
    icon: 'M12 2a3 3 0 013 3v2h1a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2V9a2 2 0 012-2h1V5a3 3 0 013-3z',
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
    id: View.DEBUGGER,
    label: 'Debugger',
    icon: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
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
    label: 'Operator Profile',
    icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  },
];

const Sidebar: React.FC<SidebarProps> = ({ activeView, onViewChange }) => {
  const handleViewChange = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const nextView = event.currentTarget.dataset.view as View | undefined;
      if (nextView) {
        onViewChange(nextView);
      }
    },
    [onViewChange],
  );

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
          {SIDEBAR_ITEMS.map((item) => (
            <button
              key={item.id}
              data-view={item.id}
              onClick={handleViewChange}
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
        <div className="flex items-center justify-between px-2 pt-2 font-mono text-[10px] text-zinc-600 uppercase">
          <span>Node: Localhost</span>
          <span className="text-emerald-500">v1.2.4</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
