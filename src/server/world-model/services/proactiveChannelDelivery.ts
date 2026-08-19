import { getWorldModelConfig } from '@/server/world-model/config';
import { markOpenLoopAsked } from '@/server/world-model/repositories/prospectiveRepository';
import {
  insertDeliveryReceipt,
  getDeliveryReceiptByOutboxEventId,
} from '@/server/world-model/repositories/deliveryReceiptRepository';
import { withWorldModelTransaction } from '@/server/world-model/db';
import { deliverOutboundWithReceipt } from '@/server/channels/outbound/router';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { ChannelType } from '@/shared/domain/types';
import type { ChannelKey } from '@/server/channels/adapters/types';
import type { OutboxEvent } from '@/server/world-model/types';
import { executeStandingIntentFollowUp } from '@/server/world-model/services/standingIntentDispatcher';

/**
 * Phase 7/8: Reale Channel-Zustellung fuer proaktive Outbox-Ereignisse.
 *
 * Dieser Handler wird vom Outbox-Dispatcher fuer `proactive.question.requested`
 * und `proactive.intent.fired` aufgerufen. Er liefert die Nachricht ueber den
 * passenden Kanal aus und persistiert den Delivery Receipt (asked-Status).
 *
 * Der Handler ist idempotent: ein Replay desselben Outbox-Events fuehrt nicht
 * zu doppelter Zustellung, weil der Outbox-Dispatcher bereits dispatched Events
 * ueberspringt.
 */

export interface ProactiveDeliveryResult {
  delivered: boolean;
  providerMessageId?: string;
  providerId?: string;
  channel?: string;
  target?: string;
  error?: string;
}

/**
 * Resolves the best channel for a user/persona from persisted binding
 * availability and optional per-binding metadata. The environment list is
 * only the default order; disconnected or unbound channels are never used.
 */
export async function resolveDeliveryChannel(
  userId: string,
  personaId: string,
): Promise<{ channel: ChannelType; externalChatId: string } | null> {
  const preferred = (
    process.env.WORLD_MODEL_PROACTIVE_CHANNELS ?? 'telegram,whatsapp,discord,slack,imessage,webchat'
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) as ChannelKey[];
  const bindings = getMessageRepository().listChannelBindings?.(userId) ?? [];
  const available = bindings
    .filter((binding) => binding.status === 'connected')
    .filter((binding) => !binding.personaId || binding.personaId === personaId)
    .filter((binding) => Boolean(binding.externalPeerId))
    .map((binding) => {
      let metadata: Record<string, unknown> = {};
      try {
        const parsed = binding.metadata ? JSON.parse(binding.metadata) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid optional metadata must not make a valid channel unusable.
      }
      const explicitPriority =
        typeof metadata.proactivePriority === 'number' &&
        Number.isFinite(metadata.proactivePriority)
          ? metadata.proactivePriority
          : null;
      const configuredIndex = preferred.indexOf(binding.channel);
      return {
        binding,
        priority:
          explicitPriority ?? (configuredIndex >= 0 ? configuredIndex : Number.MAX_SAFE_INTEGER),
      };
    })
    .sort((left, right) => left.priority - right.priority);
  for (const candidate of available) {
    const binding = candidate.binding;
    if (!binding?.externalPeerId) continue;
    const channelType = Object.values(ChannelType).find(
      (value) => value.toLowerCase() === binding.channel,
    );
    if (channelType) return { channel: channelType, externalChatId: binding.externalPeerId };
  }
  return null;
}

/**
 * Delivers a proactive question to the user via the appropriate channel.
 */
export async function deliverProactiveQuestion(
  event: OutboxEvent,
): Promise<ProactiveDeliveryResult> {
  const payload = event.payload ?? {};
  const userId = String(payload.userId ?? '');
  const personaId = String(payload.personaId ?? '');
  const question = String(payload.question ?? '');

  if (!userId || !personaId || !question) {
    return { delivered: false, error: 'missing required payload fields' };
  }

  const channel = await resolveDeliveryChannel(userId, personaId);
  if (!channel) {
    return { delivered: false, error: 'no delivery channel available' };
  }

  try {
    const receipt = await deliverOutboundWithReceipt(
      channel.channel,
      channel.externalChatId,
      question,
      { personaId },
    );
    if (!receipt)
      return {
        delivered: false,
        channel: channel.channel,
        target: channel.externalChatId,
        error: 'no outbound adapter',
      };
    return {
      delivered: true,
      channel: channel.channel,
      target: channel.externalChatId,
      providerId: receipt.providerId,
      providerMessageId: receipt.providerMessageId,
    };
  } catch (error) {
    return {
      delivered: false,
      channel: channel.channel,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delivers a standing-intent-fired notification to the user.
 */
export async function deliverIntentFiredNotification(
  event: OutboxEvent,
): Promise<ProactiveDeliveryResult> {
  const payload = event.payload ?? {};
  const userId = String(payload.userId ?? '');
  const personaId = String(payload.personaId ?? '');
  const description = String(payload.description ?? '');

  if (!userId || !personaId || !description) {
    return { delivered: false, error: 'missing required payload fields' };
  }

  const channel = await resolveDeliveryChannel(userId, personaId);
  if (!channel) {
    return { delivered: false, error: 'no delivery channel available' };
  }

  const message = `🔔 Erinnerung: ${description}`;
  try {
    const receipt = await deliverOutboundWithReceipt(
      channel.channel,
      channel.externalChatId,
      message,
      { personaId },
    );
    if (!receipt)
      return {
        delivered: false,
        channel: channel.channel,
        target: channel.externalChatId,
        error: 'no outbound adapter',
      };
    return {
      delivered: true,
      channel: channel.channel,
      target: channel.externalChatId,
      providerId: receipt.providerId,
      providerMessageId: receipt.providerMessageId,
    };
  } catch (error) {
    return {
      delivered: false,
      channel: channel.channel,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Creates an outbox handler for `proactive.question.requested` events.
 * On successful delivery, marks the open loop as `asked`.
 */
export function createProactiveQuestionHandler(): (event: OutboxEvent) => Promise<void> {
  return async (event: OutboxEvent): Promise<void> => {
    const config = getWorldModelConfig();
    if (!config.enabled && !config.e2eEnabled) return;

    const existingReceipt = await getDeliveryReceiptByOutboxEventId(event.id);
    if (existingReceipt) return;

    const result = await deliverProactiveQuestion(event);
    if (!result.delivered) {
      throw new Error(
        `[world-model:proactive] question delivery failed: ${result.error ?? 'unknown'}`,
      );
    }

    // Mark the open loop as asked after successful delivery.
    const openLoopId = String(event.payload?.openLoopId ?? event.aggregateId);
    if (openLoopId) {
      try {
        const now = new Date().toISOString();
        await withWorldModelTransaction(async (client) => {
          await insertDeliveryReceipt(
            {
              outboxEventId: event.id,
              openLoopId,
              userId: String(event.payload?.userId ?? event.userId ?? ''),
              personaId: String(event.payload?.personaId ?? event.personaId ?? ''),
              workspaceId: String(event.payload?.workspaceId ?? event.workspaceId ?? ''),
              channel: result.channel ?? 'unknown',
              target: result.target ?? '',
              providerId: result.providerId,
              providerMessageId: result.providerMessageId,
              deliveredAt: now,
              payload: { question: event.payload?.question },
            },
            client,
          );
          await markOpenLoopAsked(openLoopId, now, client);
        });
      } catch (error) {
        console.error('[world-model:proactive] failed to mark open loop as asked:', error);
        // Don't throw — delivery succeeded, just the receipt marking failed.
      }
    }
  };
}

/**
 * Creates an outbox handler for `proactive.intent.fired` events.
 */
export function createProactiveIntentFiredHandler(): (event: OutboxEvent) => Promise<void> {
  return async (event: OutboxEvent): Promise<void> => {
    const config = getWorldModelConfig();
    if (!config.enabled && !config.e2eEnabled) return;

    const existingReceipt = await getDeliveryReceiptByOutboxEventId(event.id);
    if (existingReceipt) return;

    await executeStandingIntentFollowUp({
      intentId: String(event.payload?.intentId ?? event.aggregateId),
      userId: String(event.payload?.userId ?? event.userId ?? ''),
      personaId: String(event.payload?.personaId ?? event.personaId ?? ''),
      workspaceId: String(event.payload?.workspaceId ?? event.workspaceId ?? ''),
      description: String(event.payload?.description ?? ''),
      firingObservationId: String(event.payload?.firingObservationId ?? ''),
    });

    const result = await deliverIntentFiredNotification(event);
    if (!result.delivered) {
      throw new Error(
        `[world-model:proactive] intent notification delivery failed: ${result.error ?? 'unknown'}`,
      );
    }
    await insertDeliveryReceipt({
      outboxEventId: event.id,
      userId: String(event.payload?.userId ?? event.userId ?? ''),
      personaId: String(event.payload?.personaId ?? event.personaId ?? ''),
      workspaceId: String(event.payload?.workspaceId ?? event.workspaceId ?? ''),
      channel: result.channel ?? 'unknown',
      target: result.target ?? '',
      providerId: result.providerId,
      providerMessageId: result.providerMessageId,
      payload: { description: event.payload?.description },
    });
  };
}
