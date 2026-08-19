import {
  finishActionAttempt,
  startActionAttempt,
  type ToolActionResult,
} from '@/server/world-model/repositories/actionAttemptRepository';
import { runWithWorldModelScope } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

export type { ToolActionResult } from '@/server/world-model/repositories/actionAttemptRepository';

export interface ExecuteActionInput {
  scope: WorldModelScope;
  taskId?: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
  run: () => Promise<{ ok: boolean; error?: string; result?: ToolActionResult }>;
}

export interface ExecuteActionResult {
  attemptId: string;
  created: boolean;
  succeeded: boolean;
  error?: string;
  result?: ToolActionResult;
}

/**
 * Phase 6: Fuehrt eine reale Aktion idempotent aus.
 *
 * Vor dem Tool-Aufruf wird ein Action Attempt angelegt (idempotencyKey).
 * Ein Retry mit demselben Key fuehrt den externen Seiteneffekt nicht doppelt
 * aus; der bestehende Attempt wird zurueckgegeben. `succeeded` erfordert ein
 * reales Ergebnis der `run`-Function. Tool-Receipts (Provider-ID, Ziel,
 * Zeitstempel, Payload) werden im Attempt-Output persistiert.
 */
export function executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  return runWithWorldModelScope(input.scope, () => executeActionInScope(input));
}

async function executeActionInScope(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  const { attempt, created } = await startActionAttempt({
    scope: input.scope,
    taskId: input.taskId,
    actionType: input.actionType,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  });

  // Idempotenz-Guard: bereits vorhandener (nicht wiederholender) Attempt
  // darf keinen zweiten Seiteneffekt starten.
  if (!created) {
    return {
      attemptId: attempt.id,
      created: false,
      succeeded: attempt.status === 'succeeded',
      error: attempt.status === 'failed' ? 'previous attempt failed' : undefined,
      result: attempt.result,
    };
  }

  let result: { ok: boolean; error?: string; result?: ToolActionResult };
  try {
    result = await input.run();
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.ok) {
    await finishActionAttempt(attempt.id, 'succeeded', result.result);
    return { attemptId: attempt.id, created: true, succeeded: true, result: result.result };
  }
  await finishActionAttempt(attempt.id, 'failed', result.result);
  return {
    attemptId: attempt.id,
    created: true,
    succeeded: false,
    error: result.error,
    result: result.result,
  };
}
