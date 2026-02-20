'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  View,
  ChannelType,
  ChatApprovalDecision,
  ChatStreamDebugState,
  CoupledChannel,
  MessageAttachment,
  MessageApprovalRequest,
  Message,
  Skill,
} from './types';
import Sidebar from './components/Sidebar';
import { buildInitialShellState } from './src/modules/app-shell/useAppShellState';
import {
  loadCoupledChannelsFromStorage,
  saveCoupledChannelsToStorage,
} from './src/modules/app-shell/channelStorage';
import {
  buildConversationTitle,
  removeConversationById,
  resolveActiveConversationAfterDeletion,
  STREAMING_DRAFT_ID_PREFIX,
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
import { usePersona } from './src/modules/personas/PersonaContext';
import { resolveDefaultViewFromConfig } from './src/server/config/uiRuntimeConfig';
import { getGatewayClient } from './src/modules/gateway/ws-client';

const TerminalWizard = dynamic(() => import('./components/TerminalWizard'));
const LiveCanvas = dynamic(() => import('./components/LiveCanvas').then((mod) => mod.LiveCanvas), {
  ssr: false,
});

const isPersistentSessionV2Enabled =
  String(process.env.NEXT_PUBLIC_CHAT_PERSISTENT_SESSION_V2 || 'true').toLowerCase() === 'true';

const DEFAULT_CHAT_STREAM_DEBUG: ChatStreamDebugState = {
  phase: 'idle',
  transport: 'unknown',
  updatedAt: new Date(0).toISOString(),
};

async function waitForGatewayConnected(timeoutMs = 5_000): Promise<void> {
  const client = getGatewayClient();
  if (client.state === 'connected') return;

  client.connect();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('WebSocket not connected.'));
    }, timeoutMs);

    const unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });

    if (client.state === 'connected') {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<View>(() => buildInitialShellState().currentView);
  const [onboarded, setOnboarded] = useState<boolean>(true);
  const [isCanvasOpen, setIsCanvasOpen] = useState(false);
  const [isServerResponding, setIsServerResponding] = useState(false);
  const [chatStreamDebug, setChatStreamDebug] =
    useState<ChatStreamDebugState>(DEFAULT_CHAT_STREAM_DEBUG);
  const [skills, setSkills] = useState<Skill[]>([]);
  const { activePersonaId } = usePersona();

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

  useEffect(() => {
    let cancelled = false;

    const loadConfiguredDefaultView = async () => {
      try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        const payload = (await response.json()) as { ok?: boolean; config?: unknown };
        if (!payload.ok || cancelled) {
          return;
        }
        const configuredView = resolveDefaultViewFromConfig(payload.config);
        setCurrentView((previous) => (previous === View.DASHBOARD ? configuredView : previous));
      } catch {
        // keep dashboard fallback when config cannot be loaded in client
      }
    };

    void loadConfiguredDefaultView();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    conversations,
    setConversations,
    messages,
    setMessages,
    activeConversationId,
    setActiveConversationId,
  } = useConversationSync();
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
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

      const clientMessageId = crypto.randomUUID();
      const streamingMessageId = `${STREAMING_DRAFT_ID_PREFIX}${clientMessageId}`;
      const conversationIdAtSend = activeConversationId;
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
            conversationId: activeConversationId,
            content,
            clientMessageId,
            personaId: activePersonaId || undefined,
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
          updatedAt: new Date().toISOString(),
        });
        addEventLog('SYS', error instanceof Error ? error.message : 'Message dispatch failed.');
      } finally {
        setIsServerResponding(false);
      }
    },
    [activeConversationId, activePersonaId, addEventLog, setMessages],
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

  const respondChatApproval = useCallback(
    async (
      message: Message,
      approvalRequest: MessageApprovalRequest,
      decision: ChatApprovalDecision,
    ) => {
      const conversationId = message.conversationId || activeConversationIdRef.current;
      if (!conversationId) {
        addEventLog('SYS', 'Keine aktive Conversation fuer Approval gefunden.');
        return;
      }

      setMessages((previous) =>
        previous.map((entry) =>
          entry.id === message.id
            ? { ...entry, approvalSubmitting: true, approvalError: undefined }
            : entry,
        ),
      );

      try {
        await waitForGatewayConnected();
        const gatewayClient = getGatewayClient();
        const approved = decision !== 'deny';
        const approveAlways = decision === 'approve_always';

        type ApprovalResponsePayload = {
          ok?: boolean;
          policyUpdated?: boolean;
          status?: string | null;
        };

        const payload = await gatewayClient.request<ApprovalResponsePayload>(
          'chat.approval.respond',
          {
            conversationId,
            approvalToken: approvalRequest.token,
            approved,
            approveAlways,
            toolId: approvalRequest.toolId,
            toolFunctionName: approvalRequest.toolFunctionName,
          },
        );

        setMessages((previous) =>
          previous.map((entry) =>
            entry.id === message.id
              ? {
                  ...entry,
                  approvalSubmitting: false,
                  approvalResolved: decision,
                  approvalError: undefined,
                }
              : entry,
          ),
        );

        if (approveAlways && payload?.policyUpdated) {
          addEventLog('SYS', 'Policy gespeichert: Tool steht jetzt auf approve_always.');
        } else if (approved && payload?.status === 'approval_required') {
          addEventLog('SYS', 'Weitere Genehmigung erforderlich.');
        }
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : 'Approval konnte nicht gesendet werden.';
        setMessages((previous) =>
          previous.map((entry) =>
            entry.id === message.id
              ? {
                  ...entry,
                  approvalSubmitting: false,
                  approvalError: messageText,
                }
              : entry,
          ),
        );
        addEventLog('SYS', messageText);
      }
    },
    [addEventLog, setMessages],
  );

  const handleNewConversation = useCallback(async () => {
    try {
      const response = await fetch('/api/channels/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType: ChannelType.WEBCHAT,
          title: buildConversationTitle(),
          personaId: activePersonaId || undefined,
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
  }, [addEventLog, activePersonaId, setActiveConversationId, setConversations, setMessages]);

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      const conversation = conversations.find((item) => item.id === conversationId);
      const confirmationLabel = conversation?.title || conversationId;
      if (typeof window !== 'undefined') {
        const confirmed = window.confirm(
          `Conversation "${confirmationLabel}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
        );
        if (!confirmed) {
          return;
        }
      }

      try {
        const response = await fetch(
          `/api/channels/conversations?id=${encodeURIComponent(conversationId)}`,
          { method: 'DELETE' },
        );
        const data = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        const remainingConversations = removeConversationById(conversations, conversationId);
        const nextActiveConversationId = resolveActiveConversationAfterDeletion(
          remainingConversations,
          activeConversationId,
          conversationId,
        );

        setConversations(remainingConversations);
        setActiveConversationId(nextActiveConversationId);
        if (activeConversationId === conversationId) {
          setMessages([]);
        }

        addEventLog('SYS', `Conversation gelöscht: ${confirmationLabel}`);

        if (remainingConversations.length === 0) {
          await handleNewConversation();
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Conversation konnte nicht gelöscht werden.';
        addEventLog('SYS', message);
      }
    },
    [
      activeConversationId,
      addEventLog,
      conversations,
      handleNewConversation,
      setActiveConversationId,
      setConversations,
      setMessages,
    ],
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
          skills={skills}
          setSkills={setSkills}
          messages={messages}
          conversations={conversations}
          activeConversationId={activeConversationId}
          isAgentTyping={isServerResponding || isRuntimeAgentTyping}
          chatStreamDebug={chatStreamDebug}
          onSendMessage={
            isPersistentSessionV2Enabled
              ? sendChatMessage
              : (content, platform, attachment) =>
                  routeMessage(content, platform, 'user', attachment)
          }
          onSelectConversation={setActiveConversationId}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
          coupledChannels={coupledChannels}
          onUpdateCoupling={handleUpdateCoupling}
          onSimulateIncoming={(content, platform) => routeMessage(content, platform, 'user')}
          onRespondApproval={respondChatApproval}
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
