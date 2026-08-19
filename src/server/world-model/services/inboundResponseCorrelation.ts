import { getWorldModelConfig } from '@/server/world-model/config';
import {
  correlateUserResponse,
  type CorrelatableTarget,
  type InboundUserMessage,
} from '@/server/world-model/services/responseCorrelationService';
import { resolveOpenLoopAsAnsweredInTx } from '@/server/world-model/services/openLoopService';
import { confirmEventOutcomeInTx } from '@/server/world-model/services/eventService';
import { withWorldModelTransaction } from '@/server/world-model/db';
import { listAskedOpenLoops } from '@/server/world-model/repositories/prospectiveRepository';
import { getLatestDeliveryReceiptByOpenLoopId } from '@/server/world-model/repositories/deliveryReceiptRepository';
import type { Conversation } from '@/shared/domain/types';

/**
 * Phase 9: Integriert die Antwortkorrelation in den eingehenden Nachrichtenpfad.
 *
 * Wenn ein Nutzer eine Nachricht sendet, wird geprueft, ob sie eine Antwort auf
 * eine zuvor gestellte proaktive Frage (Open Loop) oder ein Event-Follow-up ist.
 * Bei einem Treffer wird der Open Loop / das Event atomar aktualisiert.
 */

export interface InboundCorrelationInput {
  conversation: Conversation;
  userMessage: {
    text: string;
    receivedAt: string;
    observationId?: string;
    sourceId?: string;
  };
}

export interface InboundCorrelationResult {
  correlated: boolean;
  matchedType?: 'open_loop' | 'event' | 'task' | 'intent_fire';
  matchedId?: string;
  action?: 'answered' | 'confirmed' | 'none';
}

/**
 * Builds a list of correlatable targets from the user's active open loops
 * and pending event follow-ups.
 */
async function buildCorrelationCandidates(
  userId: string,
  personaId: string,
  workspaceId: string,
  conversationId: string,
): Promise<CorrelatableTarget[]> {
  const candidates: CorrelatableTarget[] = [];

  try {
    // Active open loops that have been asked (status = 'asked')
    const openLoops = await listAskedOpenLoops(userId, personaId, workspaceId, 100);
    for (const loop of openLoops) {
      if (loop.question) {
        const isEventOutcome =
          loop.type === 'event_outcome' && loop.deduplicationKey.startsWith('event-outcome:');
        candidates.push({
          id: isEventOutcome ? loop.deduplicationKey.slice('event-outcome:'.length) : loop.id,
          targetType: isEventOutcome ? 'event' : 'open_loop',
          conversationId,
          askedAt: loop.lastAskedAt,
          windowMs: 24 * 60 * 60 * 1000, // 24h response window
        });
        const receipt = await getLatestDeliveryReceiptByOpenLoopId(loop.id);
        const candidate = candidates[candidates.length - 1];
        if (receipt && candidate) {
          candidate.channel = receipt.channel;
          candidate.externalChatId = receipt.target;
        }
      }
    }
  } catch {
    // Fail-soft: correlation candidates are best-effort
  }

  return candidates;
}

/**
 * Correlates an inbound user message with pending open loops and updates
 * state atomically when a match is found.
 */
export async function correlateInboundResponse(
  input: InboundCorrelationInput,
): Promise<InboundCorrelationResult> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { correlated: false };
  }

  const { conversation, userMessage } = input;
  if (!conversation.personaId) {
    return { correlated: false };
  }

  const inboundMsg: InboundUserMessage = {
    channel: conversation.channelType,
    conversationId: conversation.id,
    text: userMessage.text,
    receivedAt: userMessage.receivedAt,
    externalChatId: conversation.externalChatId,
  };

  const candidates = await buildCorrelationCandidates(
    conversation.userId,
    conversation.personaId,
    conversation.workspaceId ?? '',
    conversation.id,
  );

  if (candidates.length === 0) {
    return { correlated: false };
  }

  const decision = correlateUserResponse(inboundMsg, candidates);

  if (!decision.match || decision.ambiguous) {
    return { correlated: false, matchedType: decision.ambiguous ? undefined : undefined };
  }

  // Atomically update the matched target.
  try {
    if (decision.match.targetType === 'open_loop') {
      await withWorldModelTransaction((client) =>
        resolveOpenLoopAsAnsweredInTx(
          decision.match!.id,
          userMessage.observationId,
          `User response correlated via ${decision.reason} match`,
          client,
        ),
      );
      return {
        correlated: true,
        matchedType: 'open_loop',
        matchedId: decision.match.id,
        action: 'answered',
      };
    }

    if (decision.match.targetType === 'event') {
      if (!userMessage.observationId || !userMessage.sourceId) {
        return { correlated: false };
      }
      await withWorldModelTransaction(async (client) => {
        await confirmEventOutcomeInTx(
          {
            eventId: decision.match!.id,
            observation: {
              userId: conversation.userId,
              personaId: conversation.personaId!,
              workspaceId: conversation.workspaceId ?? '',
              sourceType: 'chat_message',
              sourceId: userMessage.sourceId!,
              occurredAt: userMessage.receivedAt,
              payload: {
                conversationId: conversation.id,
                text: userMessage.text,
                channelType: conversation.channelType,
                externalChatId: conversation.externalChatId,
              },
              sourceAuthority: 'user',
            },
            outcome: 'completed',
          },
          client,
        );
      });
      return {
        correlated: true,
        matchedType: 'event',
        matchedId: decision.match.id,
        action: 'confirmed',
      };
    }
  } catch (error) {
    console.error('[world-model:correlation] failed to update correlated target:', error);
  }

  return { correlated: false };
}

/**
 * Lightweight check: does this message look like a response to a question?
 * Used to decide whether to run full correlation (avoids unnecessary DB queries).
 */
export function looksLikeResponse(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 2) return false;

  // Short affirmative/negative responses are strong correlation candidates.
  const shortResponses = [
    'ja',
    'nein',
    'yes',
    'no',
    'ok',
    'okay',
    'doch',
    'genau',
    'stimmt',
    'richtig',
    'falsch',
    'ja,',
    'nein,',
    'yes,',
    'no,',
    'war',
    'hatte',
    'hat',
    'habe',
    'bin',
    'waren',
  ];
  if (shortResponses.some((r) => trimmed === r || trimmed.startsWith(r))) {
    return true;
  }

  // Longer messages are less likely to be direct responses to follow-ups.
  if (trimmed.length > 200) return false;

  return false;
}
