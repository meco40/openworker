'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2, Search } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, OpenClawSession } from '@/lib/types';
import { AgentModal } from './AgentModal';
import { DiscoverAgentsModal } from './DiscoverAgentsModal';

type FilterTab = 'all' | 'working' | 'standby';

interface AgentsSidebarProps {
  workspaceId?: string;
}

function getStatusBadge(status: AgentStatus): string {
  const styles = {
    standby: 'status-standby',
    working: 'status-working',
    offline: 'status-offline',
  };
  return styles[status] || styles.standby;
}

export function AgentsSidebar({ workspaceId }: AgentsSidebarProps) {
  const {
    agents,
    selectedAgent,
    setSelectedAgent,
    agentOpenClawSessions,
    setAgentOpenClawSession,
  } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  // Load runtime session status for all agents on mount
  const loadOpenClawSessions = useCallback(async () => {
    for (const agent of agents) {
      try {
        const res = await fetch(`/api/agents/${agent.id}/openclaw`);
        if (res.ok) {
          const data = await res.json();
          if (data.linked && data.session) {
            setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
          }
        }
      } catch (error) {
        console.error(`Failed to load runtime session for ${agent.name}:`, error);
      }
    }
  }, [agents, setAgentOpenClawSession]);

  useEffect(() => {
    if (agents.length > 0) {
      loadOpenClawSessions();
    }
  }, [loadOpenClawSessions, agents.length]);

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

  const handleConnectToRuntime = async (agent: Agent, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selecting the agent
    setConnectingAgentId(agent.id);

    try {
      const existingSession = agentOpenClawSessions[agent.id];

      if (existingSession) {
        // Disconnect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'DELETE' });
        if (res.ok) {
          setAgentOpenClawSession(agent.id, null);
        }
      } else {
        // Connect
        const res = await fetch(`/api/agents/${agent.id}/openclaw`, { method: 'POST' });
        if (res.ok) {
          const data = await res.json();
          setAgentOpenClawSession(agent.id, data.session as OpenClawSession);
        } else {
          const error = await res.json();
          console.error('Failed to link runtime session:', error);
          alert(`Failed to link runtime session: ${error.error || 'Unknown error'}`);
        }
      }
    } catch (error) {
      console.error('Runtime session link error:', error);
    } finally {
      setConnectingAgentId(null);
    }
  };

  const filteredAgents = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  return (
    <aside
      className={`bg-mc-bg-secondary border-mc-border flex flex-col border-r transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-64'
      }`}
    >
      {/* Header */}
      <div className="border-mc-border border-b p-3">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text rounded p-1 transition-colors"
            aria-label={isMinimized ? 'Expand agents' : 'Minimize agents'}
          >
            {isMinimized ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
          {!isMinimized && (
            <>
              <span className="text-sm font-medium tracking-wider uppercase">Agents</span>
              <span className="bg-mc-bg-tertiary text-mc-text-secondary ml-2 rounded px-2 py-0.5 text-xs">
                {agents.length}
              </span>
            </>
          )}
        </div>

        {!isMinimized && (
          <>
            {/* Active Sub-Agents Counter */}
            {activeSubAgents > 0 && (
              <div className="mt-3 mb-3 rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-green-400">●</span>
                  <span className="text-mc-text">Active Sub-Agents:</span>
                  <span className="font-bold text-green-400">{activeSubAgents}</span>
                </div>
              </div>
            )}

            {/* Filter Tabs */}
            <div className="flex gap-1">
              {(['all', 'working', 'standby'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`rounded px-3 py-1 text-xs uppercase ${
                    filter === tab
                      ? 'bg-mc-accent text-mc-bg font-medium'
                      : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Agent List */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {filteredAgents.map((agent) => {
          const openclawSession = agentOpenClawSessions[agent.id];

          if (isMinimized) {
            // Minimized view - just avatar
            return (
              <div key={agent.id} className="flex justify-center py-3">
                <button
                  onClick={() => {
                    setSelectedAgent(agent);
                    setEditingAgent(agent);
                  }}
                  className="group relative"
                  title={`${agent.name} - ${agent.role}`}
                >
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  {openclawSession && (
                    <span className="border-mc-bg-secondary absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 bg-green-500" />
                  )}
                  {!!agent.is_master && (
                    <span className="text-mc-accent-yellow absolute -top-1 -right-1 text-xs">
                      ★
                    </span>
                  )}
                  {/* Status indicator */}
                  <span
                    className={`absolute -bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${
                      agent.status === 'working'
                        ? 'bg-mc-accent-green'
                        : agent.status === 'standby'
                          ? 'bg-mc-text-secondary'
                          : 'bg-gray-500'
                    }`}
                  />
                  {/* Tooltip */}
                  <div className="bg-mc-bg text-mc-text border-mc-border pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded border px-2 py-1 text-xs whitespace-nowrap opacity-0 group-hover:opacity-100">
                    {agent.name}
                  </div>
                </button>
              </div>
            );
          }

          // Expanded view - full agent card
          const isConnecting = connectingAgentId === agent.id;
          return (
            <div
              key={agent.id}
              className={`hover:bg-mc-bg-tertiary w-full rounded transition-colors ${
                selectedAgent?.id === agent.id ? 'bg-mc-bg-tertiary' : ''
              }`}
            >
              <button
                onClick={() => {
                  setSelectedAgent(agent);
                  setEditingAgent(agent);
                }}
                className="flex w-full items-center gap-3 p-2 text-left"
              >
                {/* Avatar */}
                <div className="relative text-2xl">
                  {agent.avatar_emoji}
                  {openclawSession && (
                    <span className="border-mc-bg-secondary absolute -right-1 -bottom-1 h-3 w-3 rounded-full border-2 bg-green-500" />
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    {!!agent.is_master && <span className="text-mc-accent-yellow text-xs">★</span>}
                  </div>
                  <div className="text-mc-text-secondary flex items-center gap-1 truncate text-xs">
                    {agent.role}
                    {agent.source === 'gateway' && (
                      <span
                        className="rounded bg-blue-500/20 px-1 py-0 text-[10px] text-blue-400"
                        title="Imported from Runtime Registry"
                      >
                        GW
                      </span>
                    )}
                  </div>
                </div>

                {/* Status */}
                <span
                  className={`rounded px-2 py-0.5 text-xs uppercase ${getStatusBadge(
                    agent.status,
                  )}`}
                >
                  {agent.status}
                </span>
              </button>

              {/* Runtime link button - show for master agents */}
              {!!agent.is_master && (
                <div className="px-2 pb-2">
                  <button
                    onClick={(e) => handleConnectToRuntime(agent, e)}
                    disabled={isConnecting}
                    className={`flex w-full items-center justify-center gap-2 rounded px-2 py-1 text-xs transition-colors ${
                      openclawSession
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-mc-bg text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text'
                    }`}
                  >
                    {isConnecting ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Linking...</span>
                      </>
                    ) : openclawSession ? (
                      <>
                        <Zap className="h-3 w-3" />
                        <span>Runtime Linked</span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="h-3 w-3" />
                        <span>Link to Runtime</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Agent / Discover Buttons */}
      {!isMinimized && (
        <div className="border-mc-border space-y-2 border-t p-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-mc-bg-tertiary hover:bg-mc-border text-mc-text-secondary hover:text-mc-text flex w-full items-center justify-center gap-2 rounded px-3 py-2 text-sm transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Agent
          </button>
          <button
            onClick={() => setShowDiscoverModal(true)}
            className="flex w-full items-center justify-center gap-2 rounded border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-sm text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300"
          >
            <Search className="h-4 w-4" />
            Import from Runtime
          </button>
        </div>
      )}

      {/* Modals */}
      {showCreateModal && (
        <AgentModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingAgent && (
        <AgentModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          workspaceId={workspaceId}
        />
      )}
      {showDiscoverModal && (
        <DiscoverAgentsModal
          onClose={() => setShowDiscoverModal(false)}
          workspaceId={workspaceId}
        />
      )}
    </aside>
  );
}
