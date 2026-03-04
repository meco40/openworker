import { useCallback } from 'react';
import type React from 'react';
import type {
  ChannelType,
  ChatApprovalDecision,
  Message,
  MessageApprovalRequest,
  MessageAttachment,
  SystemLog,
} from '@/shared/domain/types';
import { toMessage } from '@/modules/chat/services/routeMessage';
import { getGatewayClient } from '@/modules/gateway/ws-client';

interface UseChatMessageActionsArgs {
  activeConversationIdRef: React.MutableRefObject<string | null>;
  addEventLog: (type: SystemLog['type'], message: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  handleAgentResponse: (content: string, platform: ChannelType) => Promise<void>;
}

type RouteMessageRole = 'user' | 'agent' | 'system';

export function useChatMessageActions({
  activeConversationIdRef,
  addEventLog,
  setMessages,
  handleAgentResponse,
}: UseChatMessageActionsArgs) {
  const routeMessage = useCallback(
    async (
      content: string,
      platform: ChannelType,
      role: RouteMessageRole,
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
    [activeConversationIdRef, addEventLog, setMessages],
  );

  return {
    routeMessage,
    respondChatApproval,
  };
}
