import { getWorldModelDb, type WorldModelQueryExecutor } from '@/server/world-model/db';
import { upsertEntity } from '@/server/world-model/repositories/entityRepository';
import { insertOpenLoop } from '@/server/world-model/repositories/prospectiveRepository';
import type { WorldModelScope } from '@/server/world-model/scope';
import { stableDedupKey } from '@/server/world-model/projector/idempotency';

/**
 * Phase 5: Entity Service — Entity Resolution, Alias-Auflösung und
 * Disambiguation.
 *
 * Verhindert automatisches Mergen gleichnamiger Personen ohne ausreichende
 * Evidenz. Erzeugt Open Loops für ungeklärte Referenzen wie "Mike" oder
 * "Christina".
 */

export interface ResolveEntityInput {
  scope: WorldModelScope;
  name: string;
  category?: string;
  aliases?: string[];
  sourceMessageSeq?: number;
}

export interface ResolveEntityResult {
  entityId: string | null;
  resolved: boolean;
  ambiguous: boolean;
  candidates: string[];
  createdOpenLoop: boolean;
}

/**
 * Sucht eine Entität anhand ihres kanonischen Namens im Scope.
 * Bei mehreren Kandidaten gleichen Namens ohne weitere Differenzierung
 * wird ein Open Loop erzeugt statt automatisch zu mergen.
 */
export async function resolveEntity(
  input: ResolveEntityInput,
  db: WorldModelQueryExecutor = getWorldModelDb(),
): Promise<ResolveEntityResult> {
  const { scope, name, category, sourceMessageSeq } = input;

  // Kandidaten-Suche über kanonischen Namen und Aliases (case-insensitive).
  const candidates: Array<{ id: string; canonicalName: string; category: string }> = [];
  const result = await db.query<{
    id: string;
    canonical_name: string;
    category: string;
  }>(
    `SELECT id, canonical_name, category
     FROM world_model_entities
     WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
       AND (
         LOWER(canonical_name) = LOWER($4)
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(properties->'aliases') = 'array'
               THEN properties->'aliases' ELSE '[]'::jsonb END
           ) AS alias
           WHERE LOWER(alias) = LOWER($4)
         )
       )
     ORDER BY canonical_name ASC
     LIMIT 10`,
    [scope.userId, scope.personaId, scope.workspaceId ?? '', name],
  );
  candidates.push(
    ...result.rows.map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      category: row.category,
    })),
  );

  // Nur einer gefunden → eindeutig.
  if (candidates.length === 1) {
    return {
      entityId: candidates[0]!.id,
      resolved: true,
      ambiguous: false,
      candidates: [candidates[0]!.canonicalName],
      createdOpenLoop: false,
    };
  }

  // Mehrere Kandidaten gleichnamig → Rückfrage (Open Loop) statt Merge.
  if (candidates.length > 1) {
    const loopKey = stableDedupKey(
      {
        scope,
        sourceMessageSeq: sourceMessageSeq ?? 0,
        kind: 'entity_disambiguation',
        content: name,
      },
      'clarification',
    );
    await insertOpenLoop(
      {
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId ?? '',
        type: 'clarification',
        question: `Welche "${name}" meinst du? (${candidates.map((c) => c.category).join(', ')})`,
        deduplicationKey: loopKey,
      },
      db,
    );
    return {
      entityId: null,
      resolved: false,
      ambiguous: true,
      candidates: candidates.map((c) => c.canonicalName),
      createdOpenLoop: true,
    };
  }

  // Keine Entität gefunden → neue Entität anlegen (falls Kategorie bekannt).
  if (category) {
    const created = await upsertEntity(
      {
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId ?? '',
        canonicalName: name,
        category,
        owner: 'shared',
        properties: {},
      },
      db,
    );
    return {
      entityId: created.id,
      resolved: true,
      ambiguous: false,
      candidates: [name],
      createdOpenLoop: false,
    };
  }

  return {
    entityId: null,
    resolved: false,
    ambiguous: false,
    candidates: [],
    createdOpenLoop: false,
  };
}

/**
 * Erstellt eine neue Entität mit Aliases.
 */
export async function createEntityWithAliases(input: {
  scope: WorldModelScope;
  canonicalName: string;
  category: string;
  owner: 'persona' | 'user' | 'shared';
  aliases?: string[];
  db?: WorldModelQueryExecutor;
}): Promise<{ id: string }> {
  const db = input.db ?? getWorldModelDb();
  const entity = await upsertEntity(
    {
      userId: input.scope.userId,
      personaId: input.scope.personaId,
      workspaceId: input.scope.workspaceId ?? '',
      canonicalName: input.canonicalName,
      category: input.category,
      owner: input.owner,
      properties: { aliases: input.aliases ?? [] },
    },
    db,
  );

  // Aliases in properties speichern (Entity-Repository speichert sie dort).
  return { id: entity.id };
}
