'use client';

import React, { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  View,
  ChannelType,
  CoupledChannel,
  MessageAttachment,
  Team,
  WorkerTask,
  Skill,
} from './types';
import Sidebar from './components/Sidebar';
import { INITIAL_TEAMS } from './constants';
import { buildInitialShellState } from './src/modules/app-shell/useAppShellState';
import {
  loadCoupledChannelsFromStorage,
  saveCoupledChannelsToStorage,
} from './src/modules/app-shell/channelStorage';
import {
  appendMessageIfMissing,
  buildConversationTitle,
  mapConversationApiMessage,
} from './src/modules/app-shell/runtimeLogic';
import { getClientStorage } from './src/modules/app-shell/clientStorage';
import { useConversationSync } from './src/modules/app-shell/useConversationSync';
import { useGatewayState } from './src/modules/app-shell/useGatewayState';
import { useTaskScheduler } from './src/modules/app-shell/useTaskScheduler';
import { useAgentRuntime } from './src/modules/app-shell/useAgentRuntime';
import { useControlPlaneMetrics } from './src/modules/app-shell/useControlPlaneMetrics';
import { useChannelStateSync } from './src/modules/app-shell/useChannelStateSync';
import { toMessage } from './src/modules/chat/services/routeMessage';
import AppShellHeader from './src/modules/app-shell/components/AppShellHeader';
import AppShellViewContent from './src/modules/app-shell/components/AppShellViewContent';

const TerminalWizard = dynamic(() => import('./components/TerminalWizard'));
const LiveCanvas = dynamic(() => import('./components/LiveCanvas').then((mod) => mod.LiveCanvas), {
  ssr: false,
});

const isPersistentSessionV2Enabled =
  String(process.env.NEXT_PUBLIC_CHAT_PERSISTENT_SESSION_V2 || 'true').toLowerCase() === 'true';

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>(() => buildInitialShellState().currentView);
  const [onboarded, setOnboarded] = useState<boolean>(true);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [isServerResponding, setIsServerResponding] = useState(false);
  const [teams, setTeams] = useState<Team[]>(INITIAL_TEAMS);
  const [tasks] = useState<WorkerTask[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  // Load persisted skills from SQLite on mount
  useEffect(() => {
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.skills)) {
          setSkills(
            data.skills.map((s: Record<string, unknown>) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              category: s.category,
              installed: s.installed,
              version: s.version,
              functionName: s.functionName,
              source: s.source,
              sourceUrl: s.sourceUrl ?? undefined,
            })),
          );
        }
      })
      .catch((err) => console.error('Failed to load skills:', err));
  }, []);

  const [coupledChannels, setCoupledChannels] = useState<Record<string, CoupledChannel>>(() => {
    const fallbackChannels = buildInitialShellState().coupledChannels;
    return loadCoupledChannelsFromStorage(getClientStorage(), fallbackChannels);
  });

  const {
    conversations,
    setConversations,
    messages,
    setMessages,
    activeConversationId,
    setActiveConversationId,
  } = useConversationSync();
  const { gatewayState, addEventLog, updateMemoryDisplay } = useGatewayState();
  const { scheduledTasks, setScheduledTasks } = useTaskScheduler({ addEventLog, setMessages });
  const controlPlaneMetricsState = useControlPlaneMetrics();
  const { isAgentTyping: isRuntimeAgentTyping, handleAgentResponse } = useAgentRuntime({
    skills,
    addEventLog,
    setMessages,
    setScheduledTasks,
    updateMemoryDisplay,
  });

  useEffect(() => {
    saveCoupledChannelsToStorage(getClientStorage(), coupledChannels);
  }, [coupledChannels]);

  const sendChatMessage = useCallback(
    async (content: string, platform: ChannelType, attachment?: MessageAttachment) => {
      if (!activeConversationId) {
        addEventLog('SYS', 'Keine aktive Conversation verfügbar.');
        return;
      }

      const fullContent = attachment
        ? `${content}\n\n[Attached file: ${attachment.name} (${attachment.type})]`
        : content;

      setIsServerResponding(true);
      addEventLog('CHAN', `Signal via ${platform}`);

      try {
        const response = await fetch('/api/channels/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: activeConversationId,
            content: fullContent,
          }),
        });

        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
          userMessage?: {
            id: string;
            role: 'user' | 'agent' | 'system';
            content: string;
            createdAt: string;
            platform: ChannelType;
          };
          agentMessage?: {
            id: string;
            role: 'user' | 'agent' | 'system';
            content: string;
            createdAt: string;
            platform: ChannelType;
          };
        };

        if (!response.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        // Fallback in case SSE is delayed/missed: append API response once.
        if (data.userMessage && data.agentMessage) {
          const mappedUser = mapConversationApiMessage(data.userMessage);
          const mappedAgent = mapConversationApiMessage(data.agentMessage);
          setMessages((previous) => {
            const withUser = appendMessageIfMissing(previous, mappedUser);
            return appendMessageIfMissing(withUser, mappedAgent);
          });
        }
      } catch (error) {
        addEventLog('SYS', error instanceof Error ? error.message : 'Message dispatch failed.');
      } finally {
        setIsServerResponding(false);
      }
    },
    [activeConversationId, addEventLog, setMessages],
  );

  const routeMessage = useCallback(
    async (
      content: string,
      platform: ChannelType,
      role: 'user' | 'agent' | 'system',
      attachment?: MessageAttachment,
    ) => {
      const message = toMessage(content, platform, role);
      if (attachment) {
        message.attachment = attachment;
      }
      setMessages((previous) => [...previous, message]);

      if (role === 'system') {
        addEventLog('SYS', content);
      } else {
        addEventLog('CHAN', `Signal via ${platform}`);
      }

      if (role === 'user') {
        const fullContent = attachment
          ? `${content}\n\n[Attached file: ${attachment.name} (${attachment.type})]`
          : content;
        await handleAgentResponse(fullContent, platform);
      }
    },
    [addEventLog, handleAgentResponse, setMessages],
  );

  const handleNewConversation = useCallback(async () => {
    try {
      const response = await fetch('/api/channels/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType: ChannelType.WEBCHAT,
          title: buildConversationTitle(),
        }),
      });
      const data = await response.json();
      if (data.ok && data.conversation) {
        setConversations((previous) => [data.conversation, ...previous]);
        setActiveConversationId(data.conversation.id);
        setMessages([]);
        addEventLog('SYS', 'Neue Conversation erstellt.');
      }
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  }, [addEventLog, setActiveConversationId, setConversations, setMessages]);

  const handleUpdateCoupling = useCallback((id: string, update: Partial<CoupledChannel>) => {
    setCoupledChannels((previous) => ({ ...previous, [id]: { ...previous[id], ...update } }));
  }, []);
  useChannelStateSync({ onUpdateCoupling: handleUpdateCoupling });

  if (!onboarded) {
    return <TerminalWizard onComplete={() => setOnboarded(true)} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-300">
      <Sidebar
        activeView={currentView}
        onViewChange={setCurrentView}
        onToggleCanvas={() => setIsCanvasOpen(!isCanvasOpen)}
      />
      <main className="relative flex flex-1 flex-col overflow-hidden">
        <AppShellHeader metricsState={controlPlaneMetricsState} />
        <AppShellViewContent
          currentView={currentView}
          gatewayState={gatewayState}
          controlPlaneMetricsState={controlPlaneMetricsState}
          scheduledTasks={scheduledTasks}
          teams={teams}
          setTeams={setTeams}
          tasks={tasks}
          skills={skills}
          setSkills={setSkills}
          messages={messages}
          conversations={conversations}
          activeConversationId={activeConversationId}
          isAgentTyping={isServerResponding || isRuntimeAgentTyping}
          onSendMessage={
            isPersistentSessionV2Enabled
              ? sendChatMessage
              : (content, platform, attachment) =>
                  routeMessage(content, platform, 'user', attachment)
          }
          onSelectConversation={setActiveConversationId}
          onNewConversation={handleNewConversation}
          coupledChannels={coupledChannels}
          onUpdateCoupling={handleUpdateCoupling}
          onSimulateIncoming={(content, platform) => routeMessage(content, platform, 'user')}
        />
      </main>
      {isCanvasOpen && (
        <LiveCanvas
          onClose={() => setIsCanvasOpen(false)}
          isVisionEnabled={skills.find((skill) => skill.id === 'vision')?.installed}
        />
      )}
    </div>
  );
};

export default App;
