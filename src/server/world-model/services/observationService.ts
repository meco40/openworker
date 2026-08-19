import { withWorldModelTransaction } from '@/server/world-model/db';
import { insertObservationWithResult } from '@/server/world-model/repositories/observationRepository';
import { enqueueOutboxEvent } from '@/server/world-model/repositories/outboxRepository';
import { sameScope, scopeKey, type WorldModelScope } from '@/server/world-model/scope';
import type { Observation, ObservationInput } from '@/server/world-model/types';
import { getWorldModelConfig } from '@/server/world-model/config';

export interface RecordObservationResult {
  observation: Observation;
  created: boolean;
}

export type WorldModelWriteHealth = 'healthy' | 'degraded' | 'blocked';

/**
 * Phase 2 (Kanonischer Modus + atomare Schreibgrenze): `record()` ist der
 * einzige produktive Observation-Writer. Die Observation und ihr
 * `world.observation.created`-Outbox-Event werden atomar in einer
 * PostgreSQL-Transaktion geschrieben. Replay derselben Source-Identität
 * erzeugt keine Duplikate.
 *
 * Scoped: Der Aufrufer (Request- oder Scheduler-Kontext) liefert den
 * WorldModelScope; ohne passenden Scope wird abgelehnt.
 */
export async function recordObservation(
  input: ObservationInput,
  scope?: WorldModelScope,
): Promise<RecordObservationResult> {
  if (scope && !sameScope(scope, input)) {
    throw new Error('[world-model] observation scope mismatch');
  }
  const config = getWorldModelConfig();
  if (
    config.mode === 'canonical' &&
    config.canaryScopes.length > 0 &&
    !config.canaryScopes.includes(scopeKey(input))
  ) {
    throw new Error(
      `[world-model] canonical canary scope denied for ${scopeKey(input)}; add the scope to WORLD_MODEL_CANARY_SCOPES before writing`,
    );
  }
  return withWorldModelTransaction(async (client) => {
    const result = await insertObservationWithResult(input, client);
    if (result.created && (config.graphitiShadowEnabled || config.graphitiBackendEnabled)) {
      await enqueueOutboxEvent(
        {
          eventType: 'world.observation.created',
          aggregateType: 'observation',
          aggregateId: result.observation.id,
          payload: {
            ...input.payload,
            userId: input.userId,
            personaId: input.personaId,
            workspaceId: input.workspaceId ?? '',
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        },
        client,
      );
    }
    return result;
  }, scope ?? input);
}

/**
 * Ableitung des Schreib-Health aus dem aktuellen Modus. In `required`/`canonical`
 * wird eine fehlende Bestätigung (z.B. verlorene Verbindung) als `degraded`/
 * `blocked` gemeldet statt still zu schlucken.
 */
export function deriveWriteHealth(
  writeSucceeded: boolean,
  mode: 'off' | 'shadow' | 'required' | 'canonical',
): WorldModelWriteHealth {
  if (!writeSucceeded) {
    if (mode === 'canonical') return 'blocked';
    if (mode === 'required') return 'degraded';
    return 'degraded';
  }
  return 'healthy';
}

export type { ObservationInput };
