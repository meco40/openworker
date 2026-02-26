/**
 * Session creation operations.
 */

import crypto from 'node:crypto';
import { ChannelType } from '@/shared/domain/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import type { AgentV2Repository } from '@/server/agent-v2/repository';
import type { AgentV2ExtensionHost } from '@/server/agent-v2/extensions/host';
import { getMessageService } from '@/server/channels/messages/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import type { StartSessionInput, StartSessionResult } from '../types';
import { buildPendingSessionSnapshot } from '../utils';

export interface CreateSessionContext {
  repository: AgentV2Repository;
  extensionHost: AgentV2ExtensionHost;
  activeHandles: Map<string, { sessionId: string; userId: string; snapshot: unknown }>;
  runHooks: (stage: string, context: unknown) => Promise<void>;
  emitPersistedEvents: (userId: string, events: unknown[]) => void;
}

/**
 * Starts a new agent session with conversation and optional persona.
 */
export async function startSession(
  input: StartSessionInput,
  ctx: CreateSessionContext,
): Promise<StartSessionResult> {
  const now = new Date().toISOString();
  const messageService = getMessageService();
  const requestedPersonaId = String(input.personaId || '').trim() || null;

  let conversation = input.conversationId
    ? messageService.getConversation(input.conversationId, input.userId)
    : null;
  if (input.conversationId && !conversation) {
    throw new AgentV2Error('Conversation not found.', 'NOT_FOUND');
  }
  if (!conversation) {
    const externalChatId = `agent-v2-${crypto.randomUUID()}`;
    conversation = messageService.getOrCreateConversation(
      ChannelType.WEBCHAT,
      externalChatId,
      input.title || 'Agent Session',
      input.userId,
    );
  }

  if (requestedPersonaId) {
    const persona = getPersonaRepository().getPersona(requestedPersonaId);
    if (!persona) {
      throw new AgentV2Error('Persona not found.', 'INVALID_REQUEST');
    }
    messageService.setPersonaId(conversation.id, requestedPersonaId, input.userId);
    conversation = messageService.getConversation(conversation.id, input.userId) || conversation;
  }

  await ctx.runHooks('session.before_start', {
    session: buildPendingSessionSnapshot(input.userId, conversation.id, now),
    command: null,
    stage: 'session.before_start',
    payload: {
      title: input.title || null,
      personaId: requestedPersonaId,
      conversationId: conversation.id,
    },
  });

  const created = ctx.repository.createSession({
    userId: input.userId,
    conversationId: conversation.id,
    status: 'idle',
  });

  ctx.activeHandles.set(created.session.id, {
    sessionId: created.session.id,
    userId: input.userId,
    snapshot: created.session,
  });

  await ctx.runHooks('session.after_start', {
    session: created.session,
    command: null,
    stage: 'session.after_start',
    payload: {
      title: input.title || null,
      personaId: requestedPersonaId,
      conversationId: conversation.id,
    },
  });

  ctx.emitPersistedEvents(input.userId, created.events);
  return created;
}
