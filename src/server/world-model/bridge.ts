import { getWorldModelConfig } from '@/server/world-model/config';
import { recordObservation } from '@/server/world-model/services/observationService';
import { getWorldModelDb, runWithWorldModelScope } from '@/server/world-model/db';
import { matchStandingIntents } from '@/server/world-model/services/prospectiveEngine';
import { processIncomingStandingIntents } from '@/server/world-model/services/standingIntentCompiler';
import type { ObservationInput } from '@/server/world-model/types';
import { isWorldModelRequired } from '@/server/world-model/mode';

interface BridgeChatMessage {
  id?: string;
  userId: string;
  personaId: string;
  conversationId: string;
  seq: number;
  role?: string;
  content?: string;
  text?: string;
  createdAt?: string;
  sourceId?: string;
  channelType?: string;
  senderId?: string;
}

/**
 * Phase 2 (Schreibpfade vereinheitlichen): eingehende Chat-Nachrichten werden
 * zuerst als Observations in das kanonische PostgreSQL-Weltmodell geschrieben
 * (fail-soft). Mem0 und die SQLite-Knowledge-Base bleiben kompatible
 * Projektionen. Standing Intents koennen auf neue Observations reagieren.
 */
export function bridgeChatMessages(input: {
  conversationId: string;
  userId: string;
  personaId: string;
  workspaceId?: string;
  messages: BridgeChatMessage[];
}): Promise<{ written: number; skipped: number }> {
  return runWithWorldModelScope(
    {
      userId: input.userId,
      personaId: input.personaId,
      workspaceId: input.workspaceId ?? '',
    },
    () => bridgeChatMessagesInScope(input),
  );
}

async function bridgeChatMessagesInScope(input: {
  conversationId: string;
  userId: string;
  personaId: string;
  workspaceId?: string;
  messages: BridgeChatMessage[];
}): Promise<{ written: number; skipped: number }> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { written: 0, skipped: input.messages.length };
  }
  if (!config.ingestionBridgeEnabled) {
    return { written: 0, skipped: input.messages.length };
  }

  let written = 0;
  let skipped = 0;
  for (const message of input.messages) {
    const text = String(message.content ?? message.text ?? '').trim();
    if (!text) {
      skipped += 1;
      continue;
    }
    try {
      if (message.userId !== input.userId || message.personaId !== input.personaId) {
        throw new Error('[world-model:bridge] message scope does not match bridge scope');
      }
      const observationInput: ObservationInput = {
        userId: input.userId,
        personaId: input.personaId,
        workspaceId: input.workspaceId ?? '',
        sourceType: 'chat_message',
        sourceId: message.sourceId ?? message.id ?? `${message.conversationId}:${message.seq}`,
        occurredAt: message.createdAt ?? new Date().toISOString(),
        payload: {
          conversationId: message.conversationId,
          seq: message.seq,
          role: message.role ?? 'user',
          text,
          ...(message.channelType ? { channelType: message.channelType } : {}),
          ...(message.senderId ? { senderId: message.senderId } : {}),
        },
        sourceAuthority:
          message.role === 'assistant' || message.role === 'agent' ? 'persona' : 'user',
      };
      const { observation, created } = await recordObservation(observationInput, {
        userId: input.userId,
        personaId: input.personaId,
        workspaceId: input.workspaceId ?? '',
      });
      // Neue Standing-Intent-Aussagen aus Chat-Nachrichten extrahieren.
      await processIncomingStandingIntents({
        userId: input.userId,
        personaId: input.personaId,
        workspaceId: input.workspaceId ?? '',
        text: text,
      }).catch((error) => {
        console.error('[world-model:bridge] standing-intent compilation failed:', error);
      });

      if (created) {
        // Standing Intents werden erst nach dem Commit auf neue Observations geprueft.
        await matchStandingIntents(observation).catch((error) => {
          console.error('[world-model:bridge] standing-intent match failed:', error);
        });
      }
      written += 1;
    } catch (error) {
      skipped += 1;
      if (isWorldModelRequired(config.mode)) throw error;
      console.error('[world-model:bridge] observation write failed (fail-soft):', error);
    }
  }
  return { written, skipped };
}

export async function bridgeCanReachWorldModel(): Promise<boolean> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return false;
  try {
    const db = getWorldModelDb();
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
