'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, Settings, ChevronLeft, LayoutGrid } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { format } from 'date-fns';
import type { Workspace } from '@/lib/types';

interface HeaderProps {
  workspace?: Workspace;
}

export function Header({ workspace }: HeaderProps) {
  const router = useRouter();
  const { agents, tasks, isOnline } = useMissionControl();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeSubAgents, setActiveSubAgents] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load active sub-agent count
  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();

    // Poll every 30 seconds (reduced from 10s to reduce load)
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const workingAgents = agents.filter((a) => a.status === 'working').length;
  const activeAgents = workingAgents + activeSubAgents;
  const tasksInQueue = tasks.filter((t) => t.status !== 'done' && t.status !== 'review').length;

  return (
    <header className="bg-mc-bg-secondary border-mc-border flex h-14 items-center justify-between border-b px-4">
      {/* Left: Logo & Title */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Zap className="text-mc-accent-cyan h-5 w-5" />
          <span className="text-mc-text text-sm font-semibold tracking-wider uppercase">
            Mission Control
          </span>
        </div>

        {/* Workspace indicator or back to dashboard */}
        {workspace ? (
          <div className="flex items-center gap-2">
            <Link
              href="/mission-control"
              className="text-mc-text-secondary hover:text-mc-accent flex items-center gap-1 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              <LayoutGrid className="h-4 w-4" />
            </Link>
            <span className="text-mc-text-secondary">/</span>
            <div className="bg-mc-bg-tertiary flex items-center gap-2 rounded px-3 py-1">
              <span className="text-lg">{workspace.icon}</span>
              <span className="font-medium">{workspace.name}</span>
            </div>
          </div>
        ) : (
          <Link
            href="/mission-control"
            className="bg-mc-bg-tertiary hover:bg-mc-bg flex items-center gap-2 rounded px-3 py-1 transition-colors"
          >
            <LayoutGrid className="h-4 w-4" />
            <span className="text-sm">All Workspaces</span>
          </Link>
        )}
      </div>

      {/* Center: Stats - only show in workspace view */}
      {workspace && (
        <div className="flex items-center gap-8">
          <div className="text-center">
            <div className="text-mc-accent-cyan text-2xl font-bold">{activeAgents}</div>
            <div className="text-mc-text-secondary text-xs uppercase">Agents Active</div>
          </div>
          <div className="text-center">
            <div className="text-mc-accent-purple text-2xl font-bold">{tasksInQueue}</div>
            <div className="text-mc-text-secondary text-xs uppercase">Tasks in Queue</div>
          </div>
        </div>
      )}

      {/* Right: Time & Status */}
      <div className="flex items-center gap-4">
        <span className="text-mc-text-secondary font-mono text-sm">
          {format(currentTime, 'HH:mm:ss')}
        </span>
        <div
          className={`flex items-center gap-2 rounded border px-3 py-1 text-sm font-medium ${
            isOnline
              ? 'bg-mc-accent-green/20 border-mc-accent-green text-mc-accent-green'
              : 'bg-mc-accent-red/20 border-mc-accent-red text-mc-accent-red'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              isOnline ? 'bg-mc-accent-green animate-pulse' : 'bg-mc-accent-red'
            }`}
          />
          {isOnline ? 'ONLINE' : 'OFFLINE'}
        </div>
        <button
          onClick={() => router.push('/mission-control/settings')}
          className="hover:bg-mc-bg-tertiary text-mc-text-secondary rounded p-2"
          title="Settings"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
