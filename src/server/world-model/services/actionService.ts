import {
  finishActionAttempt,
  startActionAttempt,
} from '@/server/world-model/repositories/actionAttemptRepository';
import type { WorldModelScope } from '@/server/world-model/scope';

export interface ExecuteActionInput {
  scope: WorldModelScope;
  taskId?: string;
  actionType: string;
  idempotencyKey: string;
  correlationId?: string;
  run: () => Promise<{ ok: boolean; error?: string }>;
}

export interface ExecuteActionResult {
  attemptId: string;
  created: boolean;
  succeeded: boolean;
  error?: string;
}

/**
 * Phase 6: Fuehrt eine reale Aktion idempotent aus.
 *
 * Vor dem Tool-Aufruf wird ein Action Attempt angelegt (idempotencyKey).
 * Ein Retry mit demselben Key fuehrt den externen Seiteneffekt nicht doppelt
 * aus; der bestehende Attempt wird zurueckgegeben. `succeeded` erfordert ein
 * reales Ergebnis der `run`-Function.
 */
export async function executeAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
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
    };
  }

  let result: { ok: boolean; error?: string };
  try {
    result = await input.run();
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.ok) {
    await finishActionAttempt(attempt.id, 'succeeded');
    return { attemptId: attempt.id, created: true, succeeded: true };
  }
  await finishActionAttempt(attempt.id, 'failed');
  return { attemptId: attempt.id, created: true, succeeded: false, error: result.error };
}
