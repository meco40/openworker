'use client';

import React, { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { View, ChannelType, CoupledChannel, MessageAttachment, Team, WorkerTask, Skill } from './types';
import Sidebar from './components/Sidebar';
import { INITIAL_TEAMS } from './constants';
import { buildInitialShellState } from './src/modules/app-shell/useAppShellState';
import {
  loadCoupledChannelsFromStorage,
  saveCoupledChannelsToStorage,
} from './src/modules/app-shell/channelStorage';
import { buildConversationTitle } from './src/modules/app-shell/runtimeLogic';
import { getClientStorage } from './src/modules/app-shell/clientStorage';
import { useConversationSync } from './src/modules/app-shell/useConversationSync';
import { useGatewayState } from './src/modules/app-shell/useGatewayState';
import { useTaskScheduler } from './src/modules/app-shell/useTaskScheduler';
import { useAgentRuntime } from './src/modules/app-shell/useAgentRuntime';
import { toMessage } from './src/modules/chat/services/routeMessage';
import AppShellHeader from './src/modules/app-shell/components/AppShellHeader';
import AppShellViewContent from './src/modules/app-shell/components/AppShellViewContent';

const TerminalWizard = dynamic(() => import('./components/TerminalWizard'));
const LiveCanvas = dynamic(() => import('./components/LiveCanvas').then((mod) => mod.LiveCanvas), {
  ssr: false,
});

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>(() => buildInitialShellState().currentView);
  const [onboarded, setOnboarded] = useState<boolean>(true);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>(INITIAL_TEAMS);
  const [tasks, setTasks] = useState<WorkerTask[]>([]);
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
  const { isAgentTyping, handleAgentResponse } = useAgentRuntime({
    skills,
    addEventLog,
    setMessages,
    setScheduledTasks,
    updateMemoryDisplay,
  });

  useEffect(() => {
    saveCoupledChannelsToStorage(getClientStorage(), coupledChannels);
  }, [coupledChannels]);

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
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <AppShellHeader
          pendingTaskCount={scheduledTasks.filter((task) => task.status === 'pending').length}
          memoryEntryCount={gatewayState.memoryEntries.length}
        />
        <AppShellViewContent
          currentView={currentView}
          gatewayState={gatewayState}
          scheduledTasks={scheduledTasks}
          teams={teams}
          setTeams={setTeams}
          tasks={tasks}
          setTasks={setTasks}
          skills={skills}
          setSkills={setSkills}
          messages={messages}
          conversations={conversations}
          activeConversationId={activeConversationId}
          isAgentTyping={isAgentTyping}
          onSendMessage={(content, platform, attachment) =>
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
