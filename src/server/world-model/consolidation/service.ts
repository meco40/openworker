import { getWorldModelConfig } from '@/server/world-model/config';
import { insertAssertion } from '@/server/world-model/repositories/assertionRepository';
import { insertObservationWithResult } from '@/server/world-model/repositories/observationRepository';
import { withWorldModelTransaction } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';
import type { Modality } from '@/server/world-model/types';
import {
  CONSOLIDATION_POLICY_VERSION,
  normalizedSourceObservationIds,
  validateConsolidationPolicy,
} from '@/server/world-model/consolidation/policy';

/**
 * Phase 12: Konsolidierung (Dreaming/Consolidated Memories).
 *
 * Erzeugt abgeleitete Langzeit-Zusammenfassungen ohne die Wahrheit zu
 * überschreiben. Konsolidierte Erinnerungen sind bis zu ihren Observations
 * zurückverfolgbar und widerrufbar.
 *
 * Konsolidierung darf Events oder bestätigte Fakten NIEMALS direkt
 * überschreiben — sie erzeugt neue, abgeleitete Assertions mit `modality:
 * 'inferred'` und `sourceObservationId`-Verweis.
 */

export interface ConsolidationInput {
  scope: WorldModelScope;
  summary: string;
  sourceObservationIds: string[];
  predicate?: string;
}

export interface ConsolidationResult {
  assertionId: string;
  observationId: string;
  created: boolean;
}

export async function consolidateMemory(input: ConsolidationInput): Promise<ConsolidationResult> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { assertionId: '', observationId: '', created: false };
  }

  const { scope, summary } = input;
  const sourceObservationIds = normalizedSourceObservationIds(input.sourceObservationIds);
  const predicate = input.predicate ?? 'consolidated_summary';

  const policyErrors = validateConsolidationPolicy({ summary, sourceObservationIds });
  if (policyErrors.length > 0) {
    throw new Error(`[world-model:consolidation] ${policyErrors.join('; ')}`);
  }

  return withWorldModelTransaction(async (client) => {
    // 1. Abgeleitete Observation für die Konsolidierung schreiben
    const obs = await insertObservationWithResult(
      {
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId ?? '',
        sourceType: 'automation',
        sourceId: `consolidation:${scope.userId}:${scope.personaId}:${scope.workspaceId ?? ''}:${sourceObservationIds.join(',')}`,
        occurredAt: new Date().toISOString(),
        payload: {
          summary,
          sourceObservationIds,
          consolidationVersion: CONSOLIDATION_POLICY_VERSION,
          sourceCount: sourceObservationIds.length,
        },
        sourceAuthority: 'persona',
      },
      client,
    );

    if (!obs.created) {
      return { assertionId: '', observationId: obs.observation.id, created: false };
    }

    // 2. Subjekt-Entität für die Zusammenfassung finden oder anlegen
    const subjectRes = await client.query<{ id: string }>(
      `SELECT id FROM world_model_entities
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
         AND canonical_name = 'Persona' LIMIT 1`,
      [scope.userId, scope.personaId, scope.workspaceId ?? ''],
    );
    let subjectId = subjectRes.rows[0]?.id;
    if (!subjectId) {
      const entityRes = await client.query<{ id: string }>(
        `INSERT INTO world_model_entities
          (user_id, persona_id, workspace_id, canonical_name, category, owner)
         VALUES ($1,$2,$3,'Persona','person','persona')
         ON CONFLICT (user_id, persona_id, workspace_id, canonical_name, owner) DO UPDATE
           SET canonical_name = EXCLUDED.canonical_name
         RETURNING id`,
        [scope.userId, scope.personaId, scope.workspaceId ?? ''],
      );
      subjectId = entityRes.rows[0]?.id;
    }
    if (!subjectId) {
      throw new Error('[world-model:consolidation] could not resolve subject entity');
    }

    // 3. Abgeleitete Assertion mit Modality 'inferred' schreiben
    const assertion = await insertAssertion(
      {
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId ?? '',
        subjectId,
        predicate,
        objectValue: summary,
        modality: 'inferred' as Modality,
        confidence: 0.6,
        sourceObservationId: obs.observation.id,
      },
      client,
    );

    return {
      assertionId: assertion.id,
      observationId: obs.observation.id,
      created: true,
    };
  });
}
