#!/usr/bin/env node
/**
 * World Model Runtime-Role Evidence (Phase 1-3 Abnahme).
 *
 * Fuehrt den vollstaendigen kanonischen Pfad mit den produktiven
 * Runtime-Rollen aus und schreibt einen maschinenlesbaren Report:
 *
 *   admin  : Migrationen sicherstellen (WORLD_MODEL_ADMIN_DATABASE_URL)
 *   app    : Nachricht -> Observation -> canonical Commit (Events, Assertions,
 *            Entities, Relations, Tasks, Open Loops) -> Checkpoint ->
 *            Outbox-Intent, inkl. Replay-Idempotenz (WORLD_MODEL_APP_DATABASE_URL)
 *   worker : Outbox-Dispatch (Graphiti-Shadow) + Projection-Retry
 *            (Mem0 + SQLite Knowledge) (WORLD_MODEL_WORKER_DATABASE_URL)
 *   verify : Scoped Zaehler je Tabelle + Report
 *
 * Usage:
 *   pnpm run world-model:runtime-evidence -- --output docs/audits/world-model/runtime-evidence.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

// The evidence run always uses the app role first; the worker phase switches
// the runtime role explicitly. Graphiti shadow feeds the outbox so the worker
// phase has a real dispatch target. WORLD_MODEL_E2E activates the canonical
// path inside the knowledge ingestion without changing the persisted mode.
process.env.WORLD_MODEL_RUNTIME_ROLE = 'app';
process.env.GRAPHITI_SHADOW_ENABLED = 'true';
process.env.WORLD_MODEL_E2E = 'true';

import {
  closeWorldModelDb,
  getWorldModelDb,
  runWorldModelMigrations,
  runWithWorldModelScope,
} from '@/server/world-model/db';
import { recordObservation } from '@/server/world-model/services/observationService';
import { processWindow } from '@/server/knowledge/ingestion/messageProcessor';
import { getKnowledgeRepository } from '@/server/knowledge/runtime';
import { getMemoryService } from '@/server/memory/runtime';
import { upsertWorldModelIngestionCheckpoint } from '@/server/world-model/repositories/ingestionCheckpointRepository';
import { enqueueProjectionPending } from '@/server/world-model/repositories/projectionPendingRepository';
import { dispatchOutboxOnce, registerOutboxHandler } from '@/server/world-model/outboxDispatcher';
import { createGraphitiShadowHandler } from '@/server/world-model/graphiti/shadow';
import { runProjectionRetryOnce } from '@/server/world-model/services/projectionRetryWorker';
import { deleteWorldModelScope } from '@/server/world-model/dataLifecycle';
import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { WorldModelScope } from '@/server/world-model/scope';
import { ChannelType } from '@/shared/domain/types';

interface PhaseRecord {
  phase: string;
  startedAt: string;
  finishedAt?: string;
  detail?: Record<string, unknown>;
  error?: string;
}

interface EvidenceReport {
  generatedAt: string;
  evidenceClass: 'synthetic-marker';
  productionData: false;
  runtimeOverrides: string[];
  marker: string;
  scope: Required<WorldModelScope>;
  phases: PhaseRecord[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  counts: Record<string, number>;
  cleanup: { worldModelRows: number; sqliteEpisodes: number; mem0Deleted: boolean };
  ok: boolean;
}

const marker = `wm-evidence-${Date.now()}`;
const scope: Required<WorldModelScope> = {
  userId: marker,
  personaId: 'evidence-assistant',
  workspaceId: 'ws-evidence',
};
const conversationId = `${marker}-conversation`;
const windowId = `${conversationId}:1-3`;

const phases: PhaseRecord[] = [];
const checks: EvidenceReport['checks'] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

async function runPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const record: PhaseRecord = { phase: name, startedAt: new Date().toISOString() };
  phases.push(record);
  try {
    const result = await fn();
    record.detail =
      result && typeof result === 'object'
        ? (JSON.parse(JSON.stringify(result)) as Record<string, unknown>)
        : undefined;
    return result;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Run pnpm run world-model:provision-roles -- --apply first.`,
    );
  }
  return value;
}

function buildExtraction(): KnowledgeExtractionResult {
  return {
    facts: ['Das Angebot wurde an Mike geschickt.'],
    teaser: 'Angebot an Mike wurde vorbereitet und verschickt.',
    episode:
      'Erstelle eine Aufgabe: Angebot an Mike bis Freitag schicken. Ich habe das Angebot an Mike geschickt.',
    meetingLedger: {
      topicKey: 'runtime-evidence',
      counterpart: 'Mike',
      participants: ['Mike'],
      decisions: [],
      negotiatedTerms: [],
      openPoints: ['Rueckmeldung von Mike zum Angebot'],
      actionItems: ['Angebot an Mike schicken'],
      sourceRefs: [],
      confidence: 0.9,
    },
    events: [
      {
        eventType: 'meeting',
        speakerRole: 'user',
        subject: 'Angebotbesprechung mit Mike',
        counterpart: 'Mike',
        relationLabel: null,
        timeExpression: 'Freitag',
        startDate: '2026-08-21T10:00:00.000Z',
        endDate: '',
        dayCount: 1,
        isConfirmation: false,
        confirmationSignals: [],
        sourceSeq: [1],
      },
    ],
    entities: [
      {
        name: 'Mike',
        category: 'person',
        owner: 'shared',
        aliases: [],
        relations: [{ targetName: 'Angebot', relationType: 'empfaengt', direction: 'outgoing' }],
        properties: {},
        sourceSeq: [1],
      },
      {
        name: 'Angebot',
        category: 'object',
        owner: 'shared',
        aliases: [],
        relations: [],
        properties: {},
        sourceSeq: [1],
      },
    ],
  };
}

function buildWindow() {
  const messages = [
    {
      id: `${marker}-m1`,
      conversationId,
      seq: 1,
      role: 'user' as const,
      content: 'Erstelle eine Aufgabe: Angebot an Mike bis Freitag schicken.',
      platform: ChannelType.WEBCHAT,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: '2026-08-19T12:00:00.000Z',
    },
    {
      id: `${marker}-m2`,
      conversationId,
      seq: 2,
      role: 'agent' as const,
      content: 'Aufgabe erstellt: Angebot an Mike.',
      platform: ChannelType.WEBCHAT,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: '2026-08-19T12:00:05.000Z',
    },
    {
      id: `${marker}-m3`,
      conversationId,
      seq: 3,
      role: 'user' as const,
      content: 'Ich habe das Angebot an Mike geschickt.',
      platform: ChannelType.WEBCHAT,
      externalMsgId: null,
      senderName: null,
      metadata: null,
      createdAt: '2026-08-19T12:05:00.000Z',
    },
  ];
  return {
    conversationId,
    userId: scope.userId,
    personaId: scope.personaId,
    workspaceId: scope.workspaceId,
    fromSeqExclusive: 0,
    toSeqInclusive: 3,
    messages,
  };
}

async function countInScope(sql: string, params: unknown[] = []): Promise<number> {
  const result = await getWorldModelDb().query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function collectCounts(): Promise<Record<string, number>> {
  const scopeParams = [scope.userId, scope.personaId, scope.workspaceId];
  const counts: Record<string, number> = {};
  counts.observations = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_observations WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.entities = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_entities WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.relations = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_entity_relations WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.assertions = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_assertions WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.events = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_events WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.eventTransitions = await countInScope(
    `SELECT count(*)::text AS count FROM world_model_event_transitions t
       JOIN world_model_events e ON e.id = t.event_id
      WHERE e.user_id=$1 AND e.persona_id=$2 AND e.workspace_id=$3`,
    scopeParams,
  );
  counts.tasks = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_tasks WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.openLoops = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_open_loops WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.outboxDispatched = await countInScope(
    `SELECT count(*)::text AS count FROM world_model_outbox_events
      WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3 AND status='dispatched'`,
    scopeParams,
  );
  counts.outboxPending = await countInScope(
    `SELECT count(*)::text AS count FROM world_model_outbox_events
      WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3 AND status IN ('pending','failed')`,
    scopeParams,
  );
  counts.graphitiShadow = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_graphiti_shadow WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  counts.projectionPendingOpen = await countInScope(
    `SELECT count(*)::text AS count FROM world_model_projection_pending
      WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3 AND status IN ('pending','failed')`,
    scopeParams,
  );
  counts.projectionPendingSucceeded = await countInScope(
    `SELECT count(*)::text AS count FROM world_model_projection_pending
      WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3 AND status='succeeded'`,
    scopeParams,
  );
  counts.ingestionCheckpoints = await countInScope(
    'SELECT count(*)::text AS count FROM world_model_ingestion_checkpoints WHERE user_id=$1 AND persona_id=$2 AND workspace_id=$3',
    scopeParams,
  );
  return counts;
}

function countSqliteEpisodes(): number {
  const dbPath =
    process.env.KNOWLEDGE_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db';
  const absolute = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(absolute)) return -1;
  const db = new Database(absolute, { readonly: true });
  try {
    const row = db
      .prepare('SELECT count(*) AS count FROM knowledge_episodes WHERE conversation_id = ?')
      .get(conversationId) as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

async function checkMem0Reachable(): Promise<string> {
  const baseUrl = process.env.MEM0_BASE_URL?.trim();
  if (!baseUrl) return 'MEM0_BASE_URL not set';
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
    return `HTTP ${response.status}`;
  } catch (error) {
    return `unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

  const adminUrl = requireEnv('WORLD_MODEL_ADMIN_DATABASE_URL');
  const appUrl = requireEnv('WORLD_MODEL_APP_DATABASE_URL');
  requireEnv('WORLD_MODEL_WORKER_DATABASE_URL');

  // ---- Phase: admin (migrations) ----
  await runPhase('admin:migrations', async () => {
    process.env.WORLD_MODEL_APP_DATABASE_URL = adminUrl;
    const applied = await runWorldModelMigrations();
    await closeWorldModelDb();
    process.env.WORLD_MODEL_APP_DATABASE_URL = appUrl;
    return { appliedMigrations: applied };
  });
  check('admin migration pass completed', true, 'runWorldModelMigrations executed as admin');

  // ---- Phase: app (canonical write path) ----
  const appResult = await runPhase('app:canonical-write', async () => {
    return runWithWorldModelScope(scope, async () => {
      // 1) Direct canonical observation write + replay.
      const first = await recordObservation(
        {
          ...scope,
          sourceType: 'chat_message',
          sourceId: `${conversationId}:1`,
          occurredAt: '2026-08-19T12:00:00.000Z',
          payload: {
            conversationId,
            seq: 1,
            role: 'user',
            text: buildWindow().messages[0].content,
          },
          sourceAuthority: 'user',
        },
        scope,
      );
      const replay = await recordObservation(
        {
          ...scope,
          sourceType: 'chat_message',
          sourceId: `${conversationId}:1`,
          occurredAt: '2026-08-19T12:00:00.000Z',
          payload: {
            conversationId,
            seq: 1,
            role: 'user',
            text: buildWindow().messages[0].content,
          },
          sourceAuthority: 'user',
        },
        scope,
      );

      // 2) Real ingestion window through the production message processor
      //    (canonical commit + Mem0/SQLite projections), twice for idempotency.
      const canned = { extract: async () => buildExtraction() };
      const windowInput = buildWindow();
      const pass1 = await processWindow({
        window: windowInput,
        extractor: canned,
        repo: getKnowledgeRepository(),
        memoryService: getMemoryService(),
      });
      const pass2 = await processWindow({
        window: windowInput,
        extractor: canned,
        repo: getKnowledgeRepository(),
        memoryService: getMemoryService(),
      });

      // 3) Idempotent ingestion checkpoint after the canonical commit.
      const checkpoint = await upsertWorldModelIngestionCheckpoint({
        conversationId,
        userId: scope.userId,
        personaId: scope.personaId,
        workspaceId: scope.workspaceId,
        lastSeq: 3,
        sourceWindowId: windowId,
        committedObservationId: pass1.worldModelObservationId ?? null,
      });

      // 4) Retryable projection records (mirrors the ingestion failure path),
      //    drained later by the worker phase.
      await enqueueProjectionPending({
        scope,
        projectionType: 'sqlite_knowledge',
        sourceObservationId: pass1.worldModelObservationId ?? null,
        sourceWindowId: `${windowId}:retry-demo`,
        payload: {
          conversationId,
          fromSeqExclusive: 0,
          toSeqInclusive: 3,
          messages: windowInput.messages,
          rawExtraction: buildExtraction(),
          facts: buildExtraction().facts,
          memoryIds: [],
          personaName: scope.personaId,
        },
        errorMessage: 'runtime evidence: deliberate retry-path demonstration',
      });

      return {
        observationCreated: first.created,
        observationReplayCreated: replay.created,
        sameObservationId: first.observation.id === replay.observation.id,
        processWindowPass1: {
          worldModelProjected: pass1.worldModelProjected,
          factsStored: pass1.factsStored,
          mem0PendingCount: pass1.mem0PendingCount,
          eventsStored: pass1.eventsStored,
          entitiesCreated: pass1.entitiesCreated,
          taskCompletions: pass1.taskCompletions.length,
        },
        processWindowPass2: {
          worldModelProjected: pass2.worldModelProjected,
          factsStored: pass2.factsStored,
          mem0PendingCount: pass2.mem0PendingCount,
        },
        checkpointLastSeq: checkpoint.lastSeq,
      };
    });
  });

  check(
    'observation write idempotent (replay returns same row, created=false)',
    appResult.observationCreated === true &&
      appResult.observationReplayCreated === false &&
      appResult.sameObservationId === true,
    JSON.stringify({
      created: appResult.observationCreated,
      replayCreated: appResult.observationReplayCreated,
    }),
  );
  check(
    'canonical ingestion projected on both passes',
    appResult.processWindowPass1.worldModelProjected === true &&
      appResult.processWindowPass2.worldModelProjected === true,
    JSON.stringify(appResult.processWindowPass1),
  );
  check(
    'canonical factual Mem0 writes are blocked',
    appResult.processWindowPass1.factsStored === 0 &&
      appResult.processWindowPass1.mem0PendingCount === 0,
    JSON.stringify({
      factsStored: appResult.processWindowPass1.factsStored,
      mem0PendingCount: appResult.processWindowPass1.mem0PendingCount,
    }),
  );

  // ---- Phase: worker (outbox dispatch + projection retry) ----
  const workerResult = await runPhase('worker:dispatch-and-retry', async () => {
    await closeWorldModelDb();
    process.env.WORLD_MODEL_RUNTIME_ROLE = 'worker';
    registerOutboxHandler(
      'world.observation.created',
      createGraphitiShadowHandler(),
      'runtime-evidence:graphiti-shadow',
    );
    const dispatched = await runWithWorldModelScope(scope, () => dispatchOutboxOnce());
    const retry = await runWithWorldModelScope(scope, () => runProjectionRetryOnce(25));
    return { dispatched, retry };
  });
  check(
    'worker dispatched scoped outbox events',
    workerResult.dispatched >= 2,
    `dispatched=${workerResult.dispatched}`,
  );
  check(
    'worker drained retryable projections without failures',
    workerResult.retry.selected >= 1 &&
      workerResult.retry.succeeded >= 1 &&
      workerResult.retry.failed === 0,
    JSON.stringify(workerResult.retry),
  );

  // ---- Phase: verify (app role, scoped counts) ----
  const counts = await runPhase('verify:counts', async () => {
    await closeWorldModelDb();
    process.env.WORLD_MODEL_RUNTIME_ROLE = 'app';
    return runWithWorldModelScope(scope, () => collectCounts());
  });

  const sqliteEpisodes = countSqliteEpisodes();
  const mem0Status = await checkMem0Reachable();

  check(
    'observations written (direct + window)',
    counts.observations === 2,
    `=${counts.observations}`,
  );
  check('entities upserted', counts.entities >= 2, `=${counts.entities}`);
  check('relations created', counts.relations >= 1, `=${counts.relations}`);
  check('assertions created', counts.assertions >= 1, `=${counts.assertions}`);
  check('events created (replay-stable)', counts.events === 1, `=${counts.events}`);
  check('event transitions recorded', counts.eventTransitions >= 1, `=${counts.eventTransitions}`);
  check('tasks created from action items', counts.tasks >= 1, `=${counts.tasks}`);
  check('open loops created from open points', counts.openLoops >= 1, `=${counts.openLoops}`);
  check(
    'outbox fully dispatched',
    counts.outboxPending === 0 && counts.outboxDispatched >= 2,
    JSON.stringify({ dispatched: counts.outboxDispatched, pending: counts.outboxPending }),
  );
  check(
    'graphiti shadow ledger fed via outbox',
    counts.graphitiShadow >= 2,
    `=${counts.graphitiShadow}`,
  );
  check(
    'retryable projections succeeded',
    counts.projectionPendingOpen === 0 && counts.projectionPendingSucceeded >= 1,
    JSON.stringify({
      open: counts.projectionPendingOpen,
      succeeded: counts.projectionPendingSucceeded,
    }),
  );
  check(
    'ingestion checkpoint persisted',
    counts.ingestionCheckpoints === 1,
    `=${counts.ingestionCheckpoints}`,
  );
  check(
    'sqlite knowledge projection contains episode',
    sqliteEpisodes >= 1,
    `episodes=${sqliteEpisodes}`,
  );
  check('mem0 reachable for factual projection', mem0Status.startsWith('HTTP'), mem0Status);

  let cleanup: EvidenceReport['cleanup'] = {
    worldModelRows: -1,
    sqliteEpisodes: -1,
    mem0Deleted: false,
  };
  try {
    const worldModelDeletion = await deleteWorldModelScope(scope);
    const knowledgeDeleted = getKnowledgeRepository().deleteKnowledgeByScope(
      scope.userId,
      scope.personaId,
    );
    await getMemoryService().deleteByPersona(scope.personaId, scope.userId);
    const deletedWorldModelRows = Object.values(worldModelDeletion.deleted).reduce(
      (sum, count) => sum + count,
      0,
    );
    cleanup = {
      worldModelRows: deletedWorldModelRows,
      sqliteEpisodes: knowledgeDeleted,
      mem0Deleted: true,
    };
  } catch (error) {
    checks.push({
      name: 'synthetic marker cleanup',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (cleanup.worldModelRows >= 0 && cleanup.sqliteEpisodes >= 0 && cleanup.mem0Deleted) {
    checks.push({
      name: 'synthetic marker cleanup',
      passed: true,
      detail: JSON.stringify(cleanup),
    });
  }

  const report: EvidenceReport = {
    generatedAt: new Date().toISOString(),
    evidenceClass: 'synthetic-marker',
    productionData: false,
    runtimeOverrides: ['WORLD_MODEL_E2E=true', 'GRAPHITI_SHADOW_ENABLED=true'],
    marker,
    scope,
    phases,
    checks,
    counts: { ...counts, sqliteEpisodes },
    cleanup,
    ok: checks.every((entry) => entry.passed),
  };

  for (const entry of checks) {
    console.log(`${entry.passed ? 'PASS' : 'FAIL'}  ${entry.name}  (${entry.detail})`);
  }
  console.log(`mem0: ${mem0Status}`);
  console.log(`counts: ${JSON.stringify(report.counts)}`);
  console.log(`${checks.filter((entry) => entry.passed).length}/${checks.length} checks passed`);

  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Report written to ${outputPath}`);
  }
  if (!report.ok) process.exitCode = 1;

  await closeWorldModelDb();
}

void main().catch((error) => {
  for (const phase of phases) {
    console.error(
      `[phase] ${phase.phase}: ${phase.error ? `ERROR: ${phase.error}` : 'ok'} (${phase.startedAt} -> ${phase.finishedAt ?? '...'})`,
    );
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
