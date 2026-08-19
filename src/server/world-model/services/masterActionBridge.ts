import { executeMissionControlAction } from '@/server/world-model/services/missionControlBridge';
import { getWorldModelConfig } from '@/server/world-model/config';
import type { WorldModelScope } from '@/server/world-model/scope';
import type { ToolActionResult } from '@/server/world-model/services/actionService';

/**
 * Phase 6: Bruecke zwischen Master-Tool-Aktionen und kanonischen World-Model
 * Action Attempts.
 *
 * Fuehrt eine idempotente Aktion aus und persistiert das Ergebnis gleichzeitig
 * im SQLite-Master-Ledger und im kanonischen World Model. Im Canonical-Modus
 * ist der World-Model-Attempt die verbindliche Wahrheit; im Shadow-Modus dient
 * er als Vergleichsmassstab. Tool-Receipts (Provider-ID, Ziel, Zeitstempel,
 * Payload) werden im World-Model-Attempt-Output gespeichert.
 */

export interface MasterActionBridgeInput<T = unknown> {
  userId: string;
  personaId?: string;
  workspaceId?: string;
  taskId: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
  run: () => Promise<{ ok: boolean; error?: string; result: T; receipt?: ToolActionResult }>;
}

export interface MasterActionBridgeResult<T = unknown> {
  attemptId: string;
  succeeded: boolean;
  created: boolean;
  error?: string;
  replayed: boolean;
  result?: T;
  receipt?: ToolActionResult;
}

function toWorldModelScope(input: {
  userId: string;
  personaId?: string;
  workspaceId?: string;
}): WorldModelScope {
  return {
    userId: input.userId,
    personaId: input.personaId ?? 'default',
    workspaceId: input.workspaceId ?? '',
  };
}

/**
 * Fuehrt eine Master-Aktion idempotent aus und spiegelt sie ins World Model.
 * Ist das World Model nicht aktiv, wird die Aktion direkt ausgefuehrt.
 */
export async function bridgeMasterAction<T = unknown>(
  input: MasterActionBridgeInput<T>,
): Promise<MasterActionBridgeResult<T>> {
  const config = getWorldModelConfig();

  if (!config.enabled && !config.e2eEnabled) {
    const runResult = await input.run();
    return {
      attemptId: `direct-${input.idempotencyKey}`,
      succeeded: runResult.ok,
      created: true,
      error: runResult.error,
      replayed: false,
      result: runResult.result,
      receipt: runResult.receipt,
    };
  }

  let captured: { ok: boolean; error?: string; result: T; receipt?: ToolActionResult } | undefined;

  const attemptResult = await executeMissionControlAction({
    scope: toWorldModelScope(input),
    taskId: input.taskId,
    actionType: input.actionType,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    run: async () => {
      captured = await input.run();
      return { ok: captured.ok, error: captured.error, result: captured.receipt };
    },
  });

  // A replay does not execute `input.run()` and therefore has no captured
  // in-memory result. The action receipt carries the replay-safe result under
  // payload.result when the caller provided one.
  const persistedPayload = attemptResult.result?.payload;
  const replayedResult =
    persistedPayload && typeof persistedPayload === 'object' && 'result' in persistedPayload
      ? (persistedPayload as { result?: T }).result
      : undefined;

  return {
    attemptId: attemptResult.attemptId,
    succeeded: attemptResult.succeeded,
    created: attemptResult.created,
    error: attemptResult.error ?? captured?.error,
    replayed: !attemptResult.created,
    result: captured?.result ?? replayedResult,
    receipt: attemptResult.result ?? captured?.receipt,
  };
}
