import { getWorldModelConfig } from '@/server/world-model/config';
import { getWorldModelDb, runWithWorldModelScope } from '@/server/world-model/db';
import { buildEmbeddingText, hashText } from '@/server/world-model/embeddings/embeddingText';
import type { WorldModelScope } from '@/server/world-model/scope';
import {
  getConfiguredEmbeddingProvider,
  type EmbeddingProvider,
} from '@/server/world-model/embeddings/provider';

/**
 * Phase 11: Asynchroner Embedding-Worker.
 *
 * Liest unverarbeitete Outbox-Ereignisse (world.observation.created,
 * world.assertion.*, world.event.*) und erzeugt Embeddings fuer die
 * semantische Suche. Der Worker laeuft als Teil des Outbox-Dispatchers
 * oder als separater Scheduler-Takt.
 *
 * Embeddings werden versioniert (model + model_version), sodass ein
 * Modellwechsel gezieltes Re-Embedding ermoeglicht.
 */

export interface EmbeddingTarget {
  targetType: 'observation' | 'assertion' | 'event' | 'task' | 'entity' | 'episode';
  targetId: string;
  scope: WorldModelScope;
  text: string;
  textHash: string;
}

export interface EmbeddingResult {
  targetType: string;
  targetId: string;
  embedding: number[];
  model: string;
  modelVersion: string;
  created: boolean;
}

export interface EmbeddingWorkerDeps {
  /** Erzeugt ein Embedding-Vektor aus Text. */
  generateEmbedding?: (text: string) => Promise<number[]>;
  /** Aktuelles Embedding-Modell. */
  model?: string;
  modelVersion?: string;
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_MODEL_VERSION = '1';

/**
 * Sammelt Embedding-Ziele aus pending Outbox-Ereignissen.
 * In der Produktiv-Implementierung wuerde dies aus der Outbox oder
 * einer dedizierten Embedding-Queue lesen.
 */
export function collectEmbeddingTargets(
  limit = 50,
  scope?: WorldModelScope,
): Promise<EmbeddingTarget[]> {
  return scope
    ? runWithWorldModelScope(scope, () => collectEmbeddingTargetsInScope(limit, scope))
    : collectEmbeddingTargetsInScope(limit);
}

async function collectEmbeddingTargetsInScope(
  limit = 50,
  scope?: WorldModelScope,
): Promise<EmbeddingTarget[]> {
  const db = getWorldModelDb();
  const targets: EmbeddingTarget[] = [];

  try {
    const scopeFilter = scope
      ? ' AND o.user_id = $1 AND o.persona_id = $2 AND o.workspace_id = $3'
      : '';
    const scopeParams = scope
      ? [scope.userId, scope.personaId, scope.workspaceId ?? '', limit]
      : [limit];
    const limitParam = scope ? '$4' : '$1';

    // Observations. Bestehende Zeilen werden bewusst ebenfalls eingesammelt:
    // processEmbeddingBatch vergleicht den Inhaltshash und re-embeddiert damit
    // geänderte Inhalte oder Modellversionen.
    const obsRows = await db.query<{
      id: string;
      user_id: string;
      persona_id: string;
      workspace_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT o.id, o.user_id, o.persona_id, o.workspace_id, o.payload
       FROM world_model_observations o
       WHERE 1=1 ${scopeFilter}
       ORDER BY o.received_at DESC LIMIT ${limitParam}`,
      scopeParams,
    );
    for (const row of obsRows.rows) {
      const payloadText =
        typeof row.payload === 'object' ? JSON.stringify(row.payload) : String(row.payload ?? '');
      const built = buildEmbeddingText({
        targetType: 'episode',
        content: [payloadText],
      });
      if (built.text) {
        targets.push({
          targetType: 'observation',
          targetId: row.id,
          scope: { userId: row.user_id, personaId: row.persona_id, workspaceId: row.workspace_id },
          text: built.text,
          textHash: built.textHash,
        });
      }
    }

    // Assertions ohne Embedding
    const assertionRows = await db.query<{
      id: string;
      user_id: string;
      persona_id: string;
      workspace_id: string;
      predicate: string;
      object_value: string | null;
    }>(
      `SELECT a.id, a.user_id, a.persona_id, a.workspace_id, a.predicate, a.object_value
       FROM world_model_assertions a
       WHERE a.status = 'active' AND a.known_to IS NULL
       ${scope ? 'AND a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3' : ''}
       ORDER BY a.known_from DESC LIMIT ${scope ? '$4' : '$1'}`,
      scope ? [scope.userId, scope.personaId, scope.workspaceId ?? '', limit] : [limit],
    );
    for (const row of assertionRows.rows) {
      const text = `${row.predicate}: ${row.object_value ?? ''}`.trim();
      if (text) {
        targets.push({
          targetType: 'assertion',
          targetId: row.id,
          scope: { userId: row.user_id, personaId: row.persona_id, workspaceId: row.workspace_id },
          text,
          textHash: hashText(text),
        });
      }
    }

    const entityRows = await db.query<{
      id: string;
      user_id: string;
      persona_id: string;
      workspace_id: string;
      canonical_name: string;
      category: string;
    }>(
      `SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.canonical_name, e.category
       FROM world_model_entities e
       WHERE 1=1 ${scope ? 'AND e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3' : ''}
       ORDER BY e.created_at ASC LIMIT ${scope ? '$4' : '$1'}`,
      scope ? [scope.userId, scope.personaId, scope.workspaceId ?? '', limit] : [limit],
    );
    for (const row of entityRows.rows) {
      const text = `${row.canonical_name} (${row.category})`;
      targets.push({
        targetType: 'entity',
        targetId: row.id,
        scope: { userId: row.user_id, personaId: row.persona_id, workspaceId: row.workspace_id },
        text,
        textHash: hashText(text),
      });
    }

    const eventRows = await db.query<{
      id: string;
      user_id: string;
      persona_id: string;
      workspace_id: string;
      title: string;
      event_type: string;
      status: string;
    }>(
      `SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.title, e.event_type, e.status
       FROM world_model_events e
       WHERE 1=1 ${scope ? 'AND e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3' : ''}
       ORDER BY e.updated_at DESC LIMIT ${scope ? '$4' : '$1'}`,
      scope ? [scope.userId, scope.personaId, scope.workspaceId ?? '', limit] : [limit],
    );
    for (const row of eventRows.rows) {
      const text = `${row.title} (${row.event_type}) status=${row.status}`;
      targets.push({
        targetType: 'event',
        targetId: row.id,
        scope: { userId: row.user_id, personaId: row.persona_id, workspaceId: row.workspace_id },
        text,
        textHash: hashText(text),
      });
    }

    const taskRows = await db.query<{
      id: string;
      user_id: string;
      persona_id: string;
      workspace_id: string;
      title: string;
      status: string;
    }>(
      `SELECT t.id, t.user_id, t.persona_id, t.workspace_id, t.title, t.status
       FROM world_model_tasks t
       WHERE 1=1 ${scope ? 'AND t.user_id = $1 AND t.persona_id = $2 AND t.workspace_id = $3' : ''}
       ORDER BY t.updated_at DESC LIMIT ${scope ? '$4' : '$1'}`,
      scope ? [scope.userId, scope.personaId, scope.workspaceId ?? '', limit] : [limit],
    );
    for (const row of taskRows.rows) {
      const text = `${row.title} status=${row.status}`;
      targets.push({
        targetType: 'task',
        targetId: row.id,
        scope: { userId: row.user_id, personaId: row.persona_id, workspaceId: row.workspace_id },
        text,
        textHash: hashText(text),
      });
    }
  } catch (error) {
    console.error('[world-model:embeddings] failed to collect targets:', error);
  }

  return targets.slice(0, limit);
}

/**
 * Verarbeitet eine Batch von Embedding-Zielen.
 */
export async function processEmbeddingBatch(
  targets: EmbeddingTarget[],
  deps: EmbeddingWorkerDeps = {},
): Promise<EmbeddingResult[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];

  const configuredProvider = getConfiguredEmbeddingProvider();
  const model = deps.model ?? configuredProvider?.model ?? DEFAULT_MODEL;
  const modelVersion =
    deps.modelVersion ?? configuredProvider?.modelVersion ?? DEFAULT_MODEL_VERSION;
  const results: Array<EmbeddingResult | undefined> = Array.from({ length: targets.length });
  const concurrency = Math.max(
    1,
    Math.min(8, Math.floor(Number(process.env.EMBEDDING_CONCURRENCY) || 4)),
  );
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= targets.length) return;
        const target = targets[index]!;
        try {
          results[index] = await runWithWorldModelScope(target.scope, () =>
            processEmbeddingTarget(target, model, modelVersion, configuredProvider, deps),
          );
        } catch (error) {
          console.error(
            `[world-model:embeddings] failed for ${target.targetType}:${target.targetId}:`,
            error,
          );
        }
      }
    }),
  );

  return results.flatMap((result) => (result ? [result] : []));
}

async function processEmbeddingTarget(
  target: EmbeddingTarget,
  model: string,
  modelVersion: string,
  configuredProvider: EmbeddingProvider | null,
  deps: EmbeddingWorkerDeps,
): Promise<EmbeddingResult | undefined> {
  // Pruefe, ob bereits ein Embedding mit derselben Version existiert.
  const db = getWorldModelDb();
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM world_model_embeddings
     WHERE target_type = $1 AND target_id = $2
       AND model = $3 AND model_version = $4
       AND text_hash = $5 LIMIT 1`,
    [target.targetType, target.targetId, model, modelVersion, target.textHash],
  );
  if (existing.rows.length > 0) {
    return {
      targetType: target.targetType,
      targetId: target.targetId,
      embedding: [],
      model,
      modelVersion,
      created: false,
    };
  }

  let embedding: number[];
  if (deps.generateEmbedding) {
    embedding = await deps.generateEmbedding(target.text);
  } else if (configuredProvider) {
    embedding = await configuredProvider.generateEmbedding(target.text);
  } else {
    // Never persist random vectors: they would make semantic retrieval look
    // healthy while returning meaningless results.
    console.error(
      '[world-model:embeddings] no generateEmbedding provider configured; target skipped',
    );
    return undefined;
  }

  if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding provider returned an invalid vector');
  }

  await db.query(
    `INSERT INTO world_model_embeddings
     (user_id, persona_id, workspace_id, target_type, target_id,
      embedding, model, model_version, text_hash, target_content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, persona_id, workspace_id, target_type, target_id, model, model_version)
     DO UPDATE SET
       embedding = EXCLUDED.embedding,
       text_hash = EXCLUDED.text_hash,
       target_content = EXCLUDED.target_content`,
    [
      target.scope.userId,
      target.scope.personaId,
      target.scope.workspaceId ?? '',
      target.targetType,
      target.targetId,
      JSON.stringify(embedding),
      model,
      modelVersion,
      target.textHash,
      target.text,
    ],
  );

  return {
    targetType: target.targetType,
    targetId: target.targetId,
    embedding,
    model,
    modelVersion,
    created: true,
  };
}

/**
 * Fuehrt einen einzelnen Embedding-Worker-Takt aus.
 * Sammelt Ziele, verarbeitet sie und gibt Statistiken zurueck.
 */
export async function runEmbeddingWorkerOnce(
  deps: EmbeddingWorkerDeps = {},
  scope?: WorldModelScope,
): Promise<{ collected: number; processed: number; created: number }> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { collected: 0, processed: 0, created: 0 };
  }

  const targets = await collectEmbeddingTargets(50, scope);
  if (targets.length === 0) {
    return { collected: 0, processed: 0, created: 0 };
  }

  const results = await processEmbeddingBatch(targets, deps);
  return {
    collected: targets.length,
    processed: results.length,
    created: results.filter((r) => r.created).length,
  };
}

/**
 * Startet den Embedding-Worker als periodischen Takt.
 */
export function startEmbeddingWorker(
  deps: EmbeddingWorkerDeps = {},
  intervalMs = 30_000,
): { stop: () => void } {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) {
    return { stop: () => {} };
  }

  const timer = setInterval(() => {
    void runEmbeddingWorkerOnce(deps).catch((error) => {
      console.error('[world-model:embeddings] worker tick failed:', error);
    });
  }, intervalMs);
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}
