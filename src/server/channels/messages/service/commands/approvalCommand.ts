import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import type { CommandHandlerDeps } from './types';

export async function handleApprovalCommand(
  conversation: Conversation,
  payload: string,
  command: string | undefined,
  platform: ChannelType,
  externalChatId: string,
  deps: CommandHandlerDeps,
  respondToolApproval: (params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  }) => Promise<{
    ok: boolean;
    status: 'approved' | 'denied' | 'not_found' | 'approval_required';
    policyUpdated: boolean;
  }>,
): Promise<StoredMessage> {
  const token = String(payload || '').trim();
  const normalizedCommand = String(command || '')
    .trim()
    .toLowerCase();
  const approved = normalizedCommand === '/approve';

  if (!token) {
    return deps.sendResponse(
      conversation,
      'Usage: /approve <token> oder /deny <token>',
      platform,
      externalChatId,
    );
  }

  const before = deps.historyManager.listRecentMessages(conversation.id, conversation.userId, 20);
  const beforeIds = new Set(before.map((message) => message.id));

  const approvalResult = await respondToolApproval({
    conversationId: conversation.id,
    userId: conversation.userId,
    approvalToken: token,
    approved,
    approveAlways: false,
  });

  const after = deps.historyManager.listRecentMessages(conversation.id, conversation.userId, 20);
  const emittedAgentMessage =
    after.find((message) => message.role === 'agent' && !beforeIds.has(message.id)) || null;
  if (emittedAgentMessage) {
    return emittedAgentMessage;
  }

  if (approvalResult.status === 'not_found') {
    return deps.sendResponse(
      conversation,
      '⚠️ Approval-Token nicht gefunden oder abgelaufen.',
      platform,
      externalChatId,
    );
  }
  if (approvalResult.status === 'approval_required') {
    return deps.sendResponse(
      conversation,
      'Weitere Genehmigung erforderlich.',
      platform,
      externalChatId,
    );
  }
  if (approvalResult.status === 'denied') {
    return deps.sendResponse(conversation, 'Freigabe abgelehnt.', platform, externalChatId);
  }
  return deps.sendResponse(conversation, 'Freigabe verarbeitet.', platform, externalChatId);
}
