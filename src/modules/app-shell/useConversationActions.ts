import { useCallback } from 'react';
import type React from 'react';
import { ChannelType, Conversation, Message, SystemLog } from '@/shared/domain/types';
import { useConfirmDialog } from '@/components/shared/ConfirmDialogProvider';
import {
  buildConversationTitle,
  removeConversationById,
  resolveActiveConversationAfterDeletion,
} from '@/modules/app-shell/runtimeLogic';
import { buildConversationDeleteErrorMessage } from '@/modules/app-shell/conversationDeleteError';

interface UseConversationActionsArgs {
  activeConversationId: string | null;
  activePersonaId: string | null;
  conversations: Conversation[];
  addEventLog: (type: SystemLog['type'], message: string) => void;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setActiveConversationId: React.Dispatch<React.SetStateAction<string | null>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export function useConversationActions({
  activeConversationId,
  activePersonaId,
  conversations,
  addEventLog,
  setConversations,
  setActiveConversationId,
  setMessages,
}: UseConversationActionsArgs) {
  const confirm = useConfirmDialog();

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
      const confirmed = await confirm({
        title: 'Conversation löschen?',
        description: `Conversation "${confirmationLabel}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
        confirmLabel: 'Löschen',
        tone: 'danger',
      });
      if (!confirmed) {
        return;
      }

      try {
        const response = await fetch(
          `/api/channels/conversations?id=${encodeURIComponent(conversationId)}`,
          { method: 'DELETE' },
        );
        let data: { ok?: boolean; error?: string } = {};
        try {
          data = (await response.json()) as { ok?: boolean; error?: string };
        } catch {
          data = {};
        }
        if (!response.ok || !data.ok) {
          throw new Error(
            buildConversationDeleteErrorMessage({
              status: response.status,
              payloadError: data.error,
              fallback: 'Conversation konnte nicht gelöscht werden.',
            }),
          );
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
      confirm,
      conversations,
      handleNewConversation,
      setActiveConversationId,
      setConversations,
      setMessages,
    ],
  );

  return {
    handleNewConversation,
    handleDeleteConversation,
  };
}
