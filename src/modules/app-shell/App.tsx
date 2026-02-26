'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  View,
  ChannelType,
  ChatStreamDebugState,
  CoupledChannel,
  Message,
  MessageAttachment,
} from '@/shared/domain/types';
import Sidebar from '@/components/Sidebar';
import { buildInitialShellState } from '@/modules/app-shell/useAppShellState';
import {
  loadCoupledChannelsFromStorage,
  saveCoupledChannelsToStorage,
} from '@/modules/app-shell/channelStorage';
import { STREAMING_DRAFT_ID_PREFIX } from '@/modules/app-shell/runtimeLogic';
import { getClientStorage } from '@/modules/app-shell/clientStorage';
import { useConversationSync } from '@/modules/app-shell/useConversationSync';
import { useGatewayState } from '@/modules/app-shell/useGatewayState';
import { useTaskScheduler } from '@/modules/app-shell/useTaskScheduler';
import { useAgentRuntime } from '@/modules/app-shell/useAgentRuntime';
import { useControlPlaneMetrics } from '@/modules/app-shell/useControlPlaneMetrics';
import { useChannelStateSync } from '@/modules/app-shell/useChannelStateSync';
import { useSkillsCatalog } from '@/modules/app-shell/useSkillsCatalog';
import { useConversationActions } from '@/modules/app-shell/useConversationActions';
import { useChatMessageActions } from '@/modules/app-shell/useChatMessageActions';
import { waitForGatewayConnected } from '@/modules/app-shell/gatewayConnection';
import AppShellHeader from '@/modules/app-shell/components/AppShellHeader';
import AppShellViewContent from '@/modules/app-shell/components/AppShellViewContent';
import { usePersona } from '@/modules/personas/PersonaContext';
import { getGatewayClient } from '@/modules/gateway/ws-client';

const TerminalWizard = dynamic(() => import('@/components/TerminalWizard'));

const isPersistentSessionV2Enabled =
  String(process.env.NEXT_PUBLIC_CHAT_PERSISTENT_SESSION_V2 || 'true').toLowerCase() === 'true';

const DEFAULT_CHAT_STREAM_DEBUG: ChatStreamDebugState = {
  phase: 'idle',
  transport: 'unknown',
  updatedAt: new Date(0).toISOString(),
};

interface AppProps {
  initialView: View;
}

const App: React.FC<AppProps> = ({ initialView }) => {
  const [currentView, setCurrentView] = useState<View>(
    () => buildInitialShellState(initialView).currentView,
  );
  const [onboarded, setOnboarded] = useState<boolean>(true);
  const [isServerResponding, setIsServerResponding] = useState(false);
  const [chatStreamDebug, setChatStreamDebug] =
    useState<ChatStreamDebugState>(DEFAULT_CHAT_STREAM_DEBUG);
  const { activePersonaId, setDataEnabled } = usePersona();
  const shouldEnableChatData = currentView === View.CHAT;
  const shouldEnableAgentRuntime =
    currentView === View.CHAT || currentView === View.CHANNELS || currentView === View.AGENT_ROOM;
  const shouldEnablePersonaData = shouldEnableAgentRuntime || currentView === View.PERSONAS;
  const shouldLoadSkills = shouldEnableAgentRuntime || currentView === View.SKILLS;
  const { skills, setSkills } = useSkillsCatalog({ shouldLoadSkills });

  useEffect(() => {
    setDataEnabled(shouldEnablePersonaData);
  }, [setDataEnabled, shouldEnablePersonaData]);

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
  } = useConversationSync({ enabled: shouldEnableChatData });
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  const { gatewayState, addEventLog, updateMemoryDisplay } = useGatewayState();
  const { scheduledTasks, setScheduledTasks } = useTaskScheduler({ addEventLog, setMessages });
  const controlPlaneMetricsState = useControlPlaneMetrics();
  const { isAgentTyping: isRuntimeAgentTyping, handleAgentResponse } = useAgentRuntime({
    enabled: shouldEnableAgentRuntime,
    skills,
    addEventLog,
    setMessages,
    setScheduledTasks,
    updateMemoryDisplay,
  });
  const { routeMessage, respondChatApproval } = useChatMessageActions({
    activeConversationIdRef,
    addEventLog,
    setMessages,
    handleAgentResponse,
  });
  const { handleNewConversation, handleDeleteConversation } = useConversationActions({
    activeConversationId,
    activePersonaId,
    conversations,
    addEventLog,
    setConversations,
    setActiveConversationId,
    setMessages,
  });

  useEffect(() => {
    saveCoupledChannelsToStorage(getClientStorage(), coupledChannels);
  }, [coupledChannels]);

  const sendChatMessage = useCallback(
    async (
      content: string,
      platform: ChannelType,
      attachment?: MessageAttachment,
      conversationIdOverride?: string,
      personaIdOverride?: string,
    ) => {
      const resolvedConversationId = conversationIdOverride || activeConversationId;
      if (!resolvedConversationId) {
        addEventLog('SYS', 'Keine aktive Conversation verfügbar.');
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const streamingMessageId = `${STREAMING_DRAFT_ID_PREFIX}${clientMessageId}`;
      const conversationIdAtSend = resolvedConversationId;
      const streamingTimestamp = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      setChatStreamDebug({
        phase: 'running',
        transport: 'unknown',
        updatedAt: new Date().toISOString(),
      });

      setIsServerResponding(true);
      addEventLog('CHAN', `Signal via ${platform}`);
      let sawDelta = false;

      try {
        await waitForGatewayConnected();
        const gatewayClient = getGatewayClient();
        await gatewayClient.requestStream(
          'chat.stream',
          {
            conversationId: resolvedConversationId,
            content,
            clientMessageId,
            personaId: personaIdOverride || activePersonaId || undefined,
            attachment: attachment
              ? {
                  name: attachment.name,
                  type: attachment.type,
                  size: attachment.size,
                  url: attachment.url,
                }
              : undefined,
          },
          (delta) => {
            if (!delta) return;
            // Tool-call progress signals (never rendered as text)
            if (delta.startsWith('\x00tc:')) {
              const toolName = delta.slice(4) || null;
              setChatStreamDebug((prev) => ({ ...prev, activeToolCall: toolName }));
              return;
            }
            sawDelta = true;
            setIsServerResponding(false);
            setChatStreamDebug({
              phase: 'running',
              transport: 'live-delta',
              updatedAt: new Date().toISOString(),
            });
            if (activeConversationIdRef.current !== conversationIdAtSend) {
              return;
            }
            setMessages((previous) => {
              const index = previous.findIndex((message) => message.id === streamingMessageId);
              const currentText = index >= 0 ? previous[index].content : '';
              const draft = {
                id: streamingMessageId,
                role: 'agent' as const,
                content: `${currentText}${delta}`,
                timestamp: streamingTimestamp,
                conversationId: conversationIdAtSend,
                platform,
                streaming: true,
              };
              if (index >= 0) {
                const next = [...previous];
                next[index] = draft;
                return next;
              }
              return [...previous, draft];
            });
          },
        );
        if (sawDelta && activeConversationIdRef.current === conversationIdAtSend) {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === streamingMessageId ? { ...message, streaming: false } : message,
            ),
          );
        }
        setChatStreamDebug({
          phase: 'done',
          transport: sawDelta ? 'live-delta' : 'final-only',
          activeToolCall: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (activeConversationIdRef.current === conversationIdAtSend) {
          setMessages((previous) =>
            previous.filter((message) => message.id !== streamingMessageId),
          );
        }
        setChatStreamDebug({
          phase: 'error',
          transport: sawDelta ? 'live-delta' : 'unknown',
          message: error instanceof Error ? error.message : 'Message dispatch failed.',
          activeToolCall: null,
          updatedAt: new Date().toISOString(),
        });
        addEventLog('SYS', error instanceof Error ? error.message : 'Message dispatch failed.');
      } finally {
        setIsServerResponding(false);
      }
    },
    [activeConversationId, activePersonaId, addEventLog, setMessages],
  );

  const handleDeleteMessage = useCallback(
    async (message: Message) => {
      const conversationId = message.conversationId || activeConversationIdRef.current;
      if (!conversationId) {
        addEventLog(
          'SYS',
          'Nachricht konnte nicht geloescht werden (keine Conversation gefunden).',
        );
        return;
      }

      if (typeof window !== 'undefined') {
        const confirmed = window.confirm(
          'Nachricht wirklich loeschen? Diese Aktion kann nicht rueckgaengig gemacht werden.',
        );
        if (!confirmed) {
          return;
        }
      }

      try {
        const query = new URLSearchParams({
          messageId: message.id,
          conversationId,
        });
        const response = await fetch(`/api/channels/messages?${query.toString()}`, {
          method: 'DELETE',
        });
        let payload: { ok?: boolean; error?: string } = {};
        try {
          payload = (await response.json()) as { ok?: boolean; error?: string };
        } catch {
          payload = {};
        }
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || 'Nachricht konnte nicht geloescht werden.');
        }

        setMessages((previous) => previous.filter((entry) => entry.id !== message.id));
        addEventLog('SYS', 'Nachricht geloescht.');
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Nachricht konnte nicht geloescht werden.';
        addEventLog('SYS', errorMessage);
      }
    },
    [addEventLog, setMessages],
  );

  const handleUpdateCoupling = useCallback((id: string, update: Partial<CoupledChannel>) => {
    setCoupledChannels((previous) => ({ ...previous, [id]: { ...previous[id], ...update } }));
  }, []);
  useChannelStateSync({ onUpdateCoupling: handleUpdateCoupling });

  if (!onboarded) {
    return <TerminalWizard onComplete={() => setOnboarded(true)} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-300">
      <Sidebar activeView={currentView} onViewChange={setCurrentView} />
      <main className="relative flex flex-1 flex-col overflow-hidden">
        <AppShellHeader metricsState={controlPlaneMetricsState} />
        <AppShellViewContent
          currentView={currentView}
          gatewayState={gatewayState}
          controlPlaneMetricsState={controlPlaneMetricsState}
          scheduledTasks={scheduledTasks}
          skills={skills}
          setSkills={setSkills}
          messages={messages}
          conversations={conversations}
          activeConversationId={activeConversationId}
          activePersonaId={activePersonaId}
          isAgentTyping={isServerResponding || isRuntimeAgentTyping}
          chatStreamDebug={chatStreamDebug}
          onSendMessage={
            isPersistentSessionV2Enabled
              ? sendChatMessage
              : (content, platform, attachment, _conversationId, _personaId) =>
                  routeMessage(content, platform, 'user', attachment)
          }
          onSelectConversation={setActiveConversationId}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          onDeleteMessage={handleDeleteMessage}
          coupledChannels={coupledChannels}
          onUpdateCoupling={handleUpdateCoupling}
          onSimulateIncoming={(content, platform) => routeMessage(content, platform, 'user')}
          onRespondApproval={respondChatApproval}
        />
      </main>
    </div>
  );
};

export default App;
