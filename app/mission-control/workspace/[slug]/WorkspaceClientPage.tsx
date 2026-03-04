'use client';

import { useCallback, useEffect } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useMissionControl } from '@/lib/store';
import { useSSE } from '@/hooks/useSSE';
import { debug } from '@/lib/debug';
import type { Workspace } from '@/lib/types';

interface WorkspaceClientPageProps {
  slug: string;
  initialWorkspace: Workspace | null;
}

type WorkspaceRefreshReason =
  | 'initial-load'
  | 'planning-complete'
  | 'manual-fallback'
  | 'sse-fallback';

export default function WorkspaceClientPage({ slug, initialWorkspace }: WorkspaceClientPageProps) {
  const { setAgents, setTasks, setEvents, setIsOnline, setIsLoading, isLoading } =
    useMissionControl();
  const workspace: Workspace | null = initialWorkspace;
  const notFound = !workspace;
  const { isConnected: isSseConnected } = useSSE();

  const refreshWorkspaceData = useCallback(
    async (reason: WorkspaceRefreshReason) => {
      if (!workspace) return;
      const workspaceId = workspace.id;

      try {
        debug.api('Loading workspace data...', { workspaceId, reason });

        const [agentsRes, tasksRes, eventsRes] = await Promise.all([
          fetch(`/api/agents?workspace_id=${workspaceId}`),
          fetch(`/api/tasks?workspace_id=${workspaceId}`),
          fetch('/api/events'),
        ]);

        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (tasksRes.ok) {
          const tasksData = await tasksRes.json();
          debug.api('Loaded tasks', { count: tasksData.length, reason });
          setTasks(tasksData);
        }
        if (eventsRes.ok) setEvents(await eventsRes.json());
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [setAgents, setEvents, setIsLoading, setTasks, workspace],
  );

  useEffect(() => {
    if (!workspace) {
      setIsLoading(false);
    }
  }, [setIsLoading, workspace]);

  useEffect(() => {
    if (!workspace) return;

    async function checkRuntimeStatus() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const statusRes = await fetch('/api/mission-control/status', { signal: controller.signal });
        clearTimeout(timeoutId);

        if (statusRes.ok) {
          const status = await statusRes.json();
          setIsOnline(status.connected);
        }
      } catch {
        setIsOnline(false);
      }
    }

    void refreshWorkspaceData('initial-load');
    void checkRuntimeStatus();
  }, [refreshWorkspaceData, setIsOnline, workspace]);

  useEffect(() => {
    if (!workspace || isSseConnected) {
      return;
    }

    const fallbackSync = async () => {
      try {
        await refreshWorkspaceData('sse-fallback');

        const statusRes = await fetch('/api/mission-control/status');

        if (statusRes.ok) {
          const status = await statusRes.json();
          setIsOnline(status.connected);
        }
      } catch (error) {
        console.error('Fallback sync failed:', error);
      }
    };

    void fallbackSync();
    const fallbackTimer = setInterval(() => {
      void fallbackSync();
    }, 30000);

    return () => clearInterval(fallbackTimer);
  }, [workspace, isSseConnected, refreshWorkspaceData, setIsOnline]);

  if (notFound) {
    return (
      <div className="bg-mc-bg flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-6xl">🔍</div>
          <h1 className="mb-2 text-2xl font-bold">Workspace Not Found</h1>
          <p className="text-mc-text-secondary mb-6">
            The workspace &ldquo;{slug}&rdquo; doesn&apos;t exist.
          </p>
          <Link
            href="/mission-control"
            className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 inline-flex items-center gap-2 rounded-lg px-6 py-3 font-medium"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading || !workspace) {
    return (
      <div className="bg-mc-bg flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="mb-4 animate-pulse text-4xl">🦞</div>
          <p className="text-mc-text-secondary">Loading {slug}...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-mc-bg flex h-screen flex-col overflow-hidden">
      <Header workspace={workspace} />

      <div className="flex flex-1 overflow-hidden">
        <AgentsSidebar workspaceId={workspace.id} />
        <MissionQueue
          workspaceId={workspace.id}
          onRefreshWorkspaceData={async (reason) => {
            await refreshWorkspaceData(reason);
          }}
        />
        <LiveFeed />
      </div>

      <SSEDebugPanel />
    </div>
  );
}
