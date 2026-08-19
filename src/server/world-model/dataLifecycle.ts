import { createHash } from 'node:crypto';
import {
  getWorldModelDb,
  runWithWorldModelScope,
  withWorldModelTransaction,
  type WorldModelQueryExecutor,
} from '@/server/world-model/db';

export interface RetentionPolicy {
  observationsDays: number;
  assertionsDays: number;
  eventsDays: number;
  openLoopsDays: number;
  outboxDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  observationsDays: 365,
  assertionsDays: 1095,
  eventsDays: 365,
  openLoopsDays: 90,
  outboxDays: 30,
};

export interface ScopeSelector {
  userId?: string;
  personaId?: string;
  workspaceId?: string;
}

export interface WorldModelExport {
  scope: Required<Pick<ScopeSelector, 'userId' | 'personaId' | 'workspaceId'>>;
  exportedAt: string;
  schemaVersion: 1;
  manifestHash: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface WorldModelRestoreResult {
  scope: Required<Pick<ScopeSelector, 'userId' | 'personaId' | 'workspaceId'>>;
  restored: Record<string, number>;
  manifestHash: string;
}

export interface WorldModelDeletionResult {
  scope: ScopeSelector;
  deleted: Record<string, number>;
  externalProjectionCleanupRequired: Array<'mem0' | 'graphiti'>;
}

export interface WorldModelRetentionResult {
  scope: ScopeSelector;
  deleted: Record<string, number>;
  cutoff: Record<keyof RetentionPolicy, string>;
}

function assertDestructiveScope(
  scope: ScopeSelector,
): asserts scope is Required<Pick<ScopeSelector, 'userId' | 'personaId' | 'workspaceId'>> {
  if (!scope.userId || !scope.personaId || scope.workspaceId === undefined) {
    throw new Error(
      '[world-model:lifecycle] destructive operations require userId, personaId and workspaceId',
    );
  }
}

function scopedQuery(scope: ScopeSelector, alias = ''): { clause: string; values: string[] } {
  return buildScopeWhere(scope, 1, alias);
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashWorldModelExport(input: {
  scope: Required<Pick<ScopeSelector, 'userId' | 'personaId' | 'workspaceId'>>;
  tables: Record<string, Record<string, unknown>[]>;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

/**
 * Exports every canonical World-Model row for one user/persona scope. The
 * result is intentionally JSON-compatible so callers can persist it as the
 * deletion/restore evidence required by the rollout runbook.
 */
export function exportWorldModelScope(
  scope: ScopeSelector,
  db?: WorldModelQueryExecutor,
): Promise<WorldModelExport> {
  return runWithWorldModelScope(
    {
      userId: scope.userId ?? '',
      personaId: scope.personaId ?? '',
      workspaceId: scope.workspaceId ?? '',
    },
    () => exportWorldModelScopeInScope(scope, db),
  );
}

async function exportWorldModelScopeInScope(
  scope: ScopeSelector,
  db?: WorldModelQueryExecutor,
): Promise<WorldModelExport> {
  assertDestructiveScope(scope);
  const executor = db ?? getWorldModelDb();
  const tables: Array<{ name: string; query: string }> = [
    ...[
      'world_model_observations',
      'world_model_entities',
      'world_model_entity_relations',
      'world_model_assertions',
      'world_model_events',
      'world_model_tasks',
      'world_model_action_attempts',
      'world_model_open_loops',
      'world_model_standing_intents',
      'world_model_outbox_events',
      'world_model_embeddings',
      'world_model_ingestion_checkpoints',
      'world_model_projection_pending',
      'world_model_delivery_receipts',
      'world_model_rebuild_checkpoints',
      'world_model_graphiti_shadow',
    ].map((table) => ({ name: table, query: `SELECT row.* FROM ${table} row` })),
    {
      name: 'world_model_event_transitions',
      query:
        'SELECT transition.* FROM world_model_event_transitions transition JOIN world_model_events parent ON parent.id = transition.event_id',
    },
    {
      name: 'world_model_task_transitions',
      query:
        'SELECT transition.* FROM world_model_task_transitions transition JOIN world_model_tasks parent ON parent.id = transition.task_id',
    },
  ];
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    const scopeQuery = scopedQuery(scope, 'row');
    const parentScopedClause =
      table.name === 'world_model_event_transitions' ||
      table.name === 'world_model_task_transitions'
        ? scopeQuery.clause.replaceAll('row.', 'parent.')
        : scopeQuery.clause;
    const rows = await executor.query<Record<string, unknown>>(
      `${table.query} WHERE ${parentScopedClause}`,
      scopeQuery.values,
    );
    result[table.name] = rows.rows;
  }
  const exportScope = {
    userId: scope.userId,
    personaId: scope.personaId,
    workspaceId: scope.workspaceId,
  };
  return {
    scope,
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    manifestHash: hashWorldModelExport({ scope: exportScope, tables: result }),
    tables: result,
  };
}

const RESTORE_TABLE_ORDER = [
  'world_model_observations',
  'world_model_entities',
  'world_model_entity_relations',
  'world_model_assertions',
  'world_model_events',
  'world_model_tasks',
  'world_model_action_attempts',
  'world_model_open_loops',
  'world_model_standing_intents',
  'world_model_outbox_events',
  'world_model_embeddings',
  'world_model_ingestion_checkpoints',
  'world_model_projection_pending',
  'world_model_delivery_receipts',
  'world_model_rebuild_checkpoints',
  'world_model_graphiti_shadow',
  'world_model_event_transitions',
  'world_model_task_transitions',
] as const;

function assertExportScope(
  exported: WorldModelExport,
  scope: Required<Pick<ScopeSelector, 'userId' | 'personaId' | 'workspaceId'>>,
): void {
  if (exported.schemaVersion !== 1) throw new Error('Unsupported World Model export schema.');
  if (
    exported.scope.userId !== scope.userId ||
    exported.scope.personaId !== scope.personaId ||
    exported.scope.workspaceId !== scope.workspaceId
  ) {
    throw new Error('World Model export scope does not match the requested restore scope.');
  }
  const expectedHash = hashWorldModelExport({ scope, tables: exported.tables });
  if (expectedHash !== exported.manifestHash) {
    throw new Error('World Model export manifest hash does not match its table contents.');
  }
}

/** Restores a previously exported canonical scope without external providers. */
export async function restoreWorldModelScope(
  scope: ScopeSelector,
  exported: WorldModelExport,
  db?: WorldModelQueryExecutor,
): Promise<WorldModelRestoreResult> {
  assertDestructiveScope(scope);
  assertExportScope(exported, scope);
  const execute = async (client: WorldModelQueryExecutor): Promise<WorldModelRestoreResult> => {
    const restored: Record<string, number> = {};
    for (const table of RESTORE_TABLE_ORDER) {
      const rows = exported.tables[table] ?? [];
      let count = 0;
      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const columns = keys.map((key) => `"${key.replaceAll('"', '""')}"`).join(', ');
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
        const values = keys.map((key) => row[key]);
        const result = await client.query(
          `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values,
        );
        count += result.rowCount ?? 0;
      }
      restored[table] = count;
    }
    return { scope, restored, manifestHash: exported.manifestHash };
  };
  return db ? execute(db) : withWorldModelTransaction(execute, scope);
}

/**
 * Deletes the canonical rows for a scope in dependency order. External
 * projections are deliberately not guessed at: the caller must provide and
 * verify their provider-specific deletion before declaring erasure complete.
 */
export async function deleteWorldModelScope(
  scope: ScopeSelector,
  db?: WorldModelQueryExecutor,
): Promise<WorldModelDeletionResult> {
  assertDestructiveScope(scope);
  const execute = async (client: WorldModelQueryExecutor): Promise<WorldModelDeletionResult> => {
    const deleted: Record<string, number> = {};
    const statements: Array<[string, string]> = [
      [
        'world_model_delivery_receipts',
        'DELETE FROM world_model_delivery_receipts WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_projection_pending',
        'DELETE FROM world_model_projection_pending WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_outbox_events',
        'DELETE FROM world_model_outbox_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_graphiti_shadow',
        'DELETE FROM world_model_graphiti_shadow WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_rebuild_checkpoints',
        'DELETE FROM world_model_rebuild_checkpoints WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_ingestion_checkpoints',
        'DELETE FROM world_model_ingestion_checkpoints WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_action_attempts',
        'DELETE FROM world_model_action_attempts WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_open_loops',
        'DELETE FROM world_model_open_loops WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_standing_intents',
        'DELETE FROM world_model_standing_intents WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_assertions',
        'DELETE FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_events',
        'DELETE FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_tasks',
        'DELETE FROM world_model_tasks WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_entity_relations',
        'DELETE FROM world_model_entity_relations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_embeddings',
        'DELETE FROM world_model_embeddings WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_entities',
        'DELETE FROM world_model_entities WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
      [
        'world_model_observations',
        'DELETE FROM world_model_observations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3',
      ],
    ];
    for (const [table, query] of statements) {
      const result = await client.query(query, [
        scope.userId,
        scope.personaId,
        scope.workspaceId ?? '',
      ]);
      deleted[table] = result.rowCount ?? 0;
    }
    return {
      scope,
      deleted,
      externalProjectionCleanupRequired: ['mem0', 'graphiti'],
    };
  };
  return db ? execute(db) : withWorldModelTransaction(execute, scope);
}

/**
 * Applies retention only to rows that are no longer current. Active facts,
 * open loops, non-terminal events and active tasks are never removed by this
 * helper.
 */
export async function purgeWorldModelRetention(
  scope: ScopeSelector,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  db?: WorldModelQueryExecutor,
): Promise<WorldModelRetentionResult> {
  assertDestructiveScope(scope);
  const execute = async (client: WorldModelQueryExecutor): Promise<WorldModelRetentionResult> => {
    const now = new Date();
    const cutoff = Object.fromEntries(
      (Object.keys(policy) as Array<keyof RetentionPolicy>).map((key) => {
        const value = new Date(now.getTime() - retentionCutoffDays(policy, key) * 86_400_000);
        return [key, value.toISOString()];
      }),
    ) as Record<keyof RetentionPolicy, string>;
    const deleted: Record<string, number> = {};
    const statements: Array<[string, string, string]> = [
      [
        'world_model_assertions',
        'DELETE FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND known_to IS NOT NULL AND known_to < $4',
        cutoff.assertionsDays,
      ],
      [
        'world_model_events',
        "DELETE FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('completed','cancelled','no_show') AND updated_at < $4",
        cutoff.eventsDays,
      ],
      [
        'world_model_open_loops',
        "DELETE FROM world_model_open_loops WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('answered','resolved','cancelled','expired') AND updated_at < $4",
        cutoff.openLoopsDays,
      ],
      [
        'world_model_outbox_events',
        "DELETE FROM world_model_outbox_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND status IN ('dispatched','permanent_failure') AND created_at < $4",
        cutoff.outboxDays,
      ],
      [
        'world_model_observations',
        'DELETE FROM world_model_observations WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND received_at < $4',
        cutoff.observationsDays,
      ],
    ];
    for (const [table, query, cutoffValue] of statements) {
      const result = await client.query(query, [
        scope.userId,
        scope.personaId,
        scope.workspaceId ?? '',
        cutoffValue,
      ]);
      deleted[table] = result.rowCount ?? 0;
    }
    return { scope, deleted, cutoff };
  };
  return db ? execute(db) : withWorldModelTransaction(execute, scope);
}

/**
 * Phase 15 (Datenschutz/Retention): Baut idempotente DELETE-Befehle fuer
 * Export/Loeschung/Retention ueber World Model und Projektionen. Die tatsaechliche
 * Ausfuehrung erfolgt durch den Aufrufer gegen die PostgreSQL-Instanz; diese
 * Funktion liefert deterministische, scoped SQL-Bausteine und die Retention-Entscheidung.
 */
export function buildScopeWhere(
  scope: ScopeSelector,
  startIndex = 1,
  tableAlias?: string,
): {
  clause: string;
  values: string[];
} {
  const pairs: Array<[string, string | undefined]> = [
    ['user_id', scope.userId],
    ['persona_id', scope.personaId],
    ['workspace_id', scope.workspaceId],
  ];
  const clauses: string[] = [];
  const values: string[] = [];
  let index = startIndex;
  for (const [column, value] of pairs) {
    if (value === undefined) continue;
    clauses.push(`${tableAlias ? `${tableAlias}.` : ''}${column} = $${index}`);
    values.push(value);
    index += 1;
  }
  return { clause: clauses.join(' AND '), values };
}

export function retentionCutoffDays(policy: RetentionPolicy, kind: keyof RetentionPolicy): number {
  return Math.max(0, policy[kind]);
}
