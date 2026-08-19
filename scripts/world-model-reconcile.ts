#!/usr/bin/env node
/**
 * World Model Reconcile Script
 *
 * Phase 13: Vergleicht Alt- und Neusystem und erzeugt einen
 * maschinenlesbaren Abweichungsreport.
 *
 * Usage:
 *   pnpm run world-model:reconcile -- --dry-run
 *   pnpm run world-model:reconcile -- --scope user1:persona1:workspace1
 *   pnpm run world-model:reconcile -- --output report.json
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface ReconcileOptions {
  dryRun: boolean;
  scope?: string;
  output?: string;
}

interface ReconcileRow {
  domain: string;
  oldCount: number;
  newCount: number;
  difference: number;
  status: 'ok' | 'warn' | 'error';
  details?: string;
}

interface ReconcileReport {
  generatedAt: string;
  sourceSnapshotAt: string;
  mode: string;
  scope?: string;
  rows: ReconcileRow[];
  overall: 'ok' | 'warn' | 'error';
  errors: string[];
  hashes: { assertions: string[]; events: string[]; tasks: string[] };
}

function parseArgs(): ReconcileOptions {
  const args = process.argv.slice(2);
  const options: ReconcileOptions = { dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--scope':
        options.scope = args[++i];
        break;
      case '--output':
        options.output = args[++i];
        break;
    }
  }
  return options;
}

function parseScope(
  scope?: string,
): { userId?: string; personaId?: string; workspaceId?: string } | null {
  if (!scope || scope === 'all') return null;
  const parts = scope.split(':');
  const userId = parts[0] ?? '';
  const personaId = parts[1] ?? '';
  const workspaceId = parts.slice(2).join(':');
  if (
    parts.length < 3 ||
    !/^[A-Za-z0-9._-]+$/.test(userId) ||
    !/^[A-Za-z0-9._-]+$/.test(personaId) ||
    !(workspaceId === '' || /^[A-Za-z0-9._:-]+$/.test(workspaceId))
  ) {
    throw new Error('--scope must be userId:personaId:workspaceId; workspaceId may contain :');
  }
  return {
    userId,
    personaId,
    workspaceId,
  };
}

function openMessagesDb(): Database.Database {
  const dbPath = process.env.MESSAGES_DB_PATH || path.resolve('.local/messages.db');
  return new Database(dbPath, { readonly: true });
}

function openMissionControlDb(): Database.Database {
  const dbPath = process.env.DATABASE_PATH || path.resolve('mission-control.db');
  return new Database(dbPath, { readonly: true });
}

function scopedWhere(
  scope: { userId?: string; personaId?: string; workspaceId?: string } | null,
  alias = '',
): { sql: string; values: string[] } {
  if (!scope) return { sql: '1=1', values: [] };
  const prefix = alias ? `${alias}.` : '';
  return {
    sql: `${prefix}user_id = $1 AND ${prefix}persona_id = $2 AND ${prefix}workspace_id = $3`,
    values: [scope.userId!, scope.personaId!, scope.workspaceId ?? ''],
  };
}

async function runReconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    generatedAt: new Date().toISOString(),
    sourceSnapshotAt: new Date().toISOString(),
    mode: 'off',
    scope: options.scope,
    rows: [],
    overall: 'ok',
    errors: [],
    hashes: { assertions: [], events: [], tasks: [] },
  };

  console.log('=== World Model Reconcile ===');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Scope: ${options.scope ?? 'all'}`);
  console.log('');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();
    report.mode = config.mode;

    if (!config.enabled && !config.e2eEnabled) {
      console.log('World Model not enabled. Set WORLD_MODEL_ENABLED=true or WORLD_MODEL_E2E=true');
      report.overall = 'error';
      report.errors.push('World Model is disabled; no reconciliation was performed.');
      return report;
    }

    const { getWorldModelDb, runWorldModelMigrations, runWithWorldModelScope } =
      await import('@/server/world-model/db');
    await runWorldModelMigrations();
    const db = getWorldModelDb();

    const parsedScope = parseScope(options.scope);
    // Freeze the legacy source boundary before reading either side. In a live
    // dev runtime new messages may arrive while PostgreSQL is being scanned;
    // without this boundary an otherwise correct parity check reports a false
    // mismatch.
    report.sourceSnapshotAt = new Date().toISOString();
    let sqliteMessageCount = 0;
    try {
      const sqliteDb = openMessagesDb();
      const msgQuery = parsedScope
        ? `SELECT COUNT(*) as count FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.user_id = ? AND c.persona_id = ? AND m.created_at <= ?`
        : 'SELECT COUNT(*) as count FROM messages WHERE created_at <= ?';
      const msgParams = parsedScope
        ? [parsedScope.userId!, parsedScope.personaId!, report.sourceSnapshotAt]
        : [report.sourceSnapshotAt];
      const msgResult = sqliteDb.prepare(msgQuery).get(...msgParams) as { count: number };
      sqliteMessageCount = Number(msgResult.count);
      sqliteDb.close();
    } catch (error) {
      report.errors.push(
        `SQLite message snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const scopes: Array<{ userId: string; personaId: string; workspaceId: string }> = [];
    const scopeKeys = new Set<string>();
    const addScope = (scope: { userId: string; personaId: string; workspaceId: string }): void => {
      const key = `${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId}`;
      if (scopeKeys.has(key)) return;
      scopeKeys.add(key);
      scopes.push(scope);
    };

    if (parsedScope) {
      addScope({
        userId: parsedScope.userId!,
        personaId: parsedScope.personaId!,
        workspaceId: parsedScope.workspaceId ?? '',
      });
    } else {
      try {
        const sqliteDb = openMessagesDb();
        const rows = sqliteDb
          .prepare(
            `SELECT DISTINCT c.user_id, c.persona_id FROM conversations c
             WHERE c.created_at <= ? OR EXISTS (
               SELECT 1 FROM messages m
               WHERE m.conversation_id = c.id AND m.created_at <= ?
             )`,
          )
          .all(report.sourceSnapshotAt, report.sourceSnapshotAt) as Array<{
          user_id: string;
          persona_id: string;
        }>;
        for (const row of rows) {
          addScope({ userId: row.user_id, personaId: row.persona_id, workspaceId: '' });
        }
        sqliteDb.close();
      } catch {
        // ignore
      }
      if (scopes.length === 0) {
        addScope({ userId: 'default', personaId: 'default', workspaceId: '' });
      }
    }

    if (!parsedScope) {
      const worldModelScopes = await db.query<{
        user_id: string;
        persona_id: string;
        workspace_id: string;
      }>(
        `SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
         WHERE received_at <= $1
         UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
         WHERE created_at <= $1
         UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks
         WHERE created_at <= $1`,
        [report.sourceSnapshotAt],
      );
      for (const scope of worldModelScopes.rows) {
        addScope({
          userId: scope.user_id,
          personaId: scope.persona_id,
          workspaceId: scope.workspace_id,
        });
      }
    }

    let totalObsCount = 0;
    let totalChatObservationCount = 0;
    let totalActiveAssertions = 0;
    let totalSupersededAssertions = 0;
    let totalRetractedAssertions = 0;
    let totalEvents = 0;
    let totalCancelledEvents = 0;
    let totalActiveLoops = 0;
    let totalCanonicalTasks = 0;
    let totalExternalTasks = 0;
    let totalEmbeddings = 0;
    let totalEmbeddingsWithoutText = 0;
    let totalEmbeddingTargets = 0;
    let totalPendingProjections = 0;
    let totalFailedProjections = 0;
    let totalDeliveryReceipts = 0;
    let totalPendingOutbox = 0;
    let totalFailedOutbox = 0;
    const assertionHashes: string[] = [];
    const eventHashes: string[] = [];
    const taskHashes: string[] = [];

    for (const currentScope of scopes) {
      await runWithWorldModelScope(currentScope, async () => {
        const obsRes = await db.query<{ total: string; chat: string }>(
          `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE source_type = 'chat_message') AS chat
           FROM world_model_observations
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND received_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalObsCount += Number(obsRes.rows[0]?.total ?? 0);
        totalChatObservationCount += Number(obsRes.rows[0]?.chat ?? 0);

        const assRes = await db.query<{ active: string; superseded: string; retracted: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE status='active') as active,
             COUNT(*) FILTER (WHERE status='superseded') as superseded,
             COUNT(*) FILTER (WHERE status='retracted') as retracted
           FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalActiveAssertions += Number(assRes.rows[0]?.active ?? 0);
        totalSupersededAssertions += Number(assRes.rows[0]?.superseded ?? 0);
        totalRetractedAssertions += Number(assRes.rows[0]?.retracted ?? 0);

        const assHashRes = await db.query<{ hash: string }>(
          `SELECT md5(COALESCE(string_agg(
             id::text || ':' || predicate || ':' || COALESCE(object_value, ''),
             '|' ORDER BY id
           ) FILTER (WHERE status = 'active'), '')) AS hash
           FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        if (assHashRes.rows[0]?.hash) assertionHashes.push(assHashRes.rows[0].hash);

        const evRes = await db.query<{ total: string; cancelled: string }>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
           FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalEvents += Number(evRes.rows[0]?.total ?? 0);
        totalCancelledEvents += Number(evRes.rows[0]?.cancelled ?? 0);

        const evHashRes = await db.query<{ hash: string }>(
          `SELECT md5(COALESCE(string_agg(
             id::text || ':' || status::text || ':' || COALESCE(replaces_event_id::text, ''),
             '|' ORDER BY id
           ), '')) AS hash
           FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        if (evHashRes.rows[0]?.hash) eventHashes.push(evHashRes.rows[0].hash);

        const loopRes = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM world_model_open_loops
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND status IN ('open','scheduled','asked') AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalActiveLoops += Number(loopRes.rows[0]?.count ?? 0);

        const taskRes = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM world_model_tasks
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalCanonicalTasks += Number(taskRes.rows[0]?.count ?? 0);

        const externalTaskRes = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM world_model_tasks
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND external_task_id IS NOT NULL AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalExternalTasks += Number(externalTaskRes.rows[0]?.count ?? 0);

        const taskHashRes = await db.query<{ hash: string }>(
          `SELECT md5(COALESCE(string_agg(
             id::text || ':' || status::text || ':' || title,
             '|' ORDER BY id
           ), '')) AS hash
           FROM world_model_tasks WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        if (taskHashRes.rows[0]?.hash) taskHashes.push(taskHashRes.rows[0].hash);

        const embRes = await db.query<{ total: string; without_text: string }>(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE target_content IS NULL OR target_content = '') AS without_text
           FROM world_model_embeddings WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalEmbeddings += Number(embRes.rows[0]?.total ?? 0);
        totalEmbeddingsWithoutText += Number(embRes.rows[0]?.without_text ?? 0);

        const targetRes = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM (
             SELECT id FROM world_model_observations
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND received_at <= $4
             UNION ALL
             SELECT id FROM world_model_entities
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
             UNION ALL
             SELECT id FROM world_model_assertions
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
               AND status = 'active' AND known_to IS NULL AND created_at <= $4
             UNION ALL
             SELECT id FROM world_model_events
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
             UNION ALL
             SELECT id FROM world_model_tasks
             WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
           ) targets`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalEmbeddingTargets += Number(targetRes.rows[0]?.count ?? 0);

        const pendRes = await db.query<{ pending: string; failed: string }>(
          `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed
           FROM world_model_projection_pending
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalPendingProjections += Number(pendRes.rows[0]?.pending ?? 0);
        totalFailedProjections += Number(pendRes.rows[0]?.failed ?? 0);

        const recRes = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM world_model_delivery_receipts
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND delivered_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalDeliveryReceipts += Number(recRes.rows[0]?.count ?? 0);

        const outRes = await db.query<{ pending: string; failed: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE status='pending') as pending,
             COUNT(*) FILTER (WHERE status='failed') as failed
           FROM world_model_outbox_events
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND created_at <= $4`,
          [
            currentScope.userId,
            currentScope.personaId,
            currentScope.workspaceId,
            report.sourceSnapshotAt,
          ],
        );
        totalPendingOutbox += Number(outRes.rows[0]?.pending ?? 0);
        totalFailedOutbox += Number(outRes.rows[0]?.failed ?? 0);
      });
    }

    report.rows.push({
      domain: 'observations',
      oldCount: sqliteMessageCount,
      newCount: totalChatObservationCount,
      difference: totalChatObservationCount - sqliteMessageCount,
      status: totalChatObservationCount === sqliteMessageCount ? 'ok' : 'error',
      details: `chat_message observations vs SQLite message snapshot at ${report.sourceSnapshotAt}; total canonical observations including derived sources=${totalObsCount}`,
    });

    report.rows.push({
      domain: 'assertions',
      oldCount: totalActiveAssertions,
      newCount: totalActiveAssertions,
      difference: 0,
      status: 'ok',
      details: `canonical active=${totalActiveAssertions}; historical superseded=${totalSupersededAssertions}, retracted=${totalRetractedAssertions}`,
    });

    report.rows.push({
      domain: 'events',
      oldCount: totalEvents,
      newCount: totalEvents,
      difference: 0,
      status: 'ok',
      details: `canonical total=${totalEvents}; cancelled historical=${totalCancelledEvents}`,
    });

    report.rows.push({
      domain: 'open_loops (active)',
      oldCount: totalActiveLoops,
      newCount: totalActiveLoops,
      difference: 0,
      status: totalActiveLoops > 100 ? 'warn' : 'ok',
      details: `active open loops`,
    });

    let oldTaskCount = totalCanonicalTasks;
    try {
      const sqliteDb = openMissionControlDb();
      const taskQuery = parsedScope
        ? 'SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND updated_at <= ?'
        : 'SELECT COUNT(*) as count FROM tasks WHERE updated_at <= ?';
      const oldTask = sqliteDb
        .prepare(taskQuery)
        .get(
          ...(parsedScope
            ? [parsedScope.workspaceId!, report.sourceSnapshotAt]
            : [report.sourceSnapshotAt]),
        ) as {
        count: number;
      };
      oldTaskCount = Number(oldTask.count);
      sqliteDb.close();
    } catch (error) {
      report.errors.push(
        `SQLite task count failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    report.rows.push({
      domain: 'tasks',
      oldCount: oldTaskCount,
      newCount: totalExternalTasks,
      difference: totalExternalTasks - oldTaskCount,
      status: totalExternalTasks === oldTaskCount ? 'ok' : 'error',
      details: `legacy Mission-Control mirror=${totalExternalTasks}, sqlite=${oldTaskCount}; derived internal tasks=${totalCanonicalTasks - totalExternalTasks}`,
    });

    report.rows.push({
      domain: 'embeddings',
      oldCount: totalEmbeddingTargets,
      newCount: totalEmbeddings,
      difference: totalEmbeddings - totalEmbeddingTargets,
      status:
        totalEmbeddings === totalEmbeddingTargets && totalEmbeddingsWithoutText === 0
          ? 'ok'
          : 'error',
      details: `targets=${totalEmbeddingTargets}, stored=${totalEmbeddings}, without_text=${totalEmbeddingsWithoutText}`,
    });

    report.rows.push({
      domain: 'projection_pending',
      oldCount: 0,
      newCount: totalPendingProjections + totalFailedProjections,
      difference: totalPendingProjections + totalFailedProjections,
      status: totalFailedProjections > 0 ? 'error' : totalPendingProjections > 0 ? 'warn' : 'ok',
      details: `pending=${totalPendingProjections}, failed=${totalFailedProjections}`,
    });

    report.rows.push({
      domain: 'delivery_receipts',
      oldCount: 0,
      newCount: totalDeliveryReceipts,
      difference: 0,
      status: 'ok',
      details: 'provider acknowledgements inventory; no legacy row mapping exists',
    });

    report.rows.push({
      domain: 'outbox',
      oldCount: 0,
      newCount: totalPendingOutbox + totalFailedOutbox,
      difference: totalPendingOutbox + totalFailedOutbox,
      status: totalFailedOutbox > 10 ? 'error' : totalPendingOutbox > 100 ? 'warn' : 'ok',
      details: `pending=${totalPendingOutbox}, failed=${totalFailedOutbox}`,
    });

    // Determine overall status
    for (const row of report.rows) {
      if (row.status === 'error') {
        report.overall = 'error';
        break;
      }
      if (row.status === 'warn' && report.overall !== 'error') {
        report.overall = 'warn';
      }
    }
    report.hashes = {
      assertions: assertionHashes,
      events: eventHashes,
      tasks: taskHashes,
    };
    if (report.errors.length > 0) report.overall = 'error';

    if (options.dryRun) {
      console.log('[DRY RUN] Reconcile report would be generated. No changes made.');
    }

    console.log('');
    console.log('=== Reconcile Report ===');
    for (const row of report.rows) {
      const icon = row.status === 'ok' ? '✅' : row.status === 'warn' ? '⚠️' : '❌';
      console.log(
        `${icon} ${row.domain}: old=${row.oldCount}, new=${row.newCount}, diff=${row.difference}${row.details ? ` (${row.details})` : ''}`,
      );
    }
    console.log('');
    console.log(`Overall: ${report.overall}`);

    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(report, null, 2));
      console.log(`Report written to ${options.output}`);
    }
  } catch (error) {
    report.errors.push(
      `Reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    report.overall = 'error';
    console.error('Reconcile failed:', error);
  }

  return report;
}

const options = parseArgs();
void runReconcile(options).then((report) => {
  if (report.errors.length > 0) {
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`  - ${error}`);
    }
  }
  process.exit(report.overall !== 'ok' || report.errors.length > 0 ? 1 : 0);
});
