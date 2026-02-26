'use client';

import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

/**
 * Replay utilities for recovering swarm state from session events.
 */

interface ReplayCommandState {
  nextSeq: number;
  text: string;
  completed: boolean;
  failed: boolean;
  errorMessage: string | null;
}

export function consumeReplayForCommand(params: {
  events: AgentV2EventEnvelope[];
  commandId: string;
  fromSeq: number;
  text: string;
}): ReplayCommandState {
  const commandId = String(params.commandId || '').trim();
  let nextSeq = Math.max(0, Math.floor(params.fromSeq || 0));
  let text = String(params.text || '');
  let completed = false;
  let failed = false;
  let errorMessage: string | null = null;

  for (const event of params.events) {
    if (!event || typeof event.seq !== 'number') continue;
    if (event.seq > nextSeq) nextSeq = event.seq;
    if (event.commandId !== commandId) continue;

    if (event.type === 'agent.v2.model.delta') {
      const delta = String((event.payload as { delta?: unknown })?.delta || '');
      if (delta) text += delta;
      continue;
    }

    if (event.type === 'agent.v2.error') {
      failed = true;
      const message = String((event.payload as { message?: unknown })?.message || '').trim();
      errorMessage = message || 'Phase command failed.';
      continue;
    }

    if (event.type === 'agent.v2.command.completed') {
      const status = String((event.payload as { status?: unknown })?.status || '').trim();
      if (status === 'failed' || status === 'failed_recoverable' || status === 'aborted') {
        failed = true;
        errorMessage = `Phase command ended with status: ${status}`;
      } else {
        const resultMessage = String(
          ((event.payload as { result?: { message?: unknown } })?.result?.message as string) || '',
        ).trim();
        if (!text.trim() && resultMessage) {
          text = resultMessage;
        }
        completed = true;
      }
    }
  }

  return { nextSeq, text, completed, failed, errorMessage };
}

export function shouldFallbackToSessionSnapshot(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /REPLAY_WINDOW_EXPIRED|Replay window expired/i.test(message);
}
