#!/usr/bin/env node
/**
 * World Model Backfill Script
 *
 * Phase 13: Ueberfuehrt historische Chat-Nachrichten, SQLite Knowledge,
 * bestehende Tasks und Mem0-Fakten reproduzierbar in das World Model.
 *
 * Usage:
 *   pnpm run world-model:backfill -- --dry-run
 *   pnpm run world-model:backfill -- --scope user1:persona1:workspace1
 *   pnpm run world-model:backfill -- --batch-size 100 --resume
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runWithWorldModelScope, type WorldModelQueryExecutor } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface BackfillOptions {
  dryRun: boolean;
  scope?: string; // "userId:personaId:workspaceId"
  batchSize: number;
  resume: boolean;
  output?: string;
  timeRange?: { from: string; to: string };
}

interface BackfillStats {
  observationsWritten: number;
  observationsSkipped: number;
  assertionsCreated: number;
  eventsCreated: number;
  entitiesUpserted: number;
  tasksMirrored: number;
  actionAttemptsMirrored: number;
  errors: string[];
  generatedAt: string;
  phases: Record<string, { selected: number; processed: number; skipped: number; failed: number }>;
}

interface SqliteMessage {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  platform: string;
  external_msg_id: string | null;
  sender_name: string | null;
  metadata: string | null;
  created_at: string;
  client_message_id: string | null;
}

interface SqliteConversation {
  id: string;
  channel_type: string;
  external_chat_id: string | null;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  persona_id: string | null;
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  const options: BackfillOptions = {
    dryRun: false,
    batchSize: 50,
    resume: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--scope':
        options.scope = args[++i];
        break;
      case '--batch-size':
        options.batchSize = Number(args[++i]) || 50;
        break;
      case '--resume':
        options.resume = true;
        break;
      case '--output':
        options.output = args[++i];
        break;
      case '--from':
        options.timeRange = {
          from: args[++i],
          to: options.timeRange?.to ?? new Date().toISOString(),
        };
        break;
      case '--to':
        options.timeRange = { from: options.timeRange?.from ?? '2020-01-01', to: args[++i] };
        break;
    }
  }

  return options;
}

function parseScope(
  scope?: string,
): { userId?: string; personaId?: string; workspaceId?: string } | null {
  if (!scope) return null;
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

function openMasterDb(): Database.Database {
  const dbPath = process.env.MASTER_DB_PATH || path.resolve('.local/master.db');
  return new Database(dbPath, { readonly: true });
}

async function getBackfillProgress(
  db: WorldModelQueryExecutor,
  scope: WorldModelScope,
  phase: string,
  resume: boolean,
): Promise<number> {
  const { runWithWorldModelScope } = await import('@/server/world-model/db');
  return runWithWorldModelScope(scope, async () => {
    if (!resume) {
      await db.query(
        `DELETE FROM world_model_rebuild_checkpoints
         WHERE projection_type = 'backfill' AND user_id = $1 AND persona_id = $2
           AND workspace_id = $3 AND phase = $4`,
        [scope.userId, scope.personaId, scope.workspaceId ?? '', phase],
      );
      return 0;
    }
    const result = await db.query<{ processed_count: number }>(
      `SELECT processed_count FROM world_model_rebuild_checkpoints
       WHERE projection_type = 'backfill' AND user_id = $1 AND persona_id = $2
         AND workspace_id = $3 AND phase = $4`,
      [scope.userId, scope.personaId, scope.workspaceId ?? '', phase],
    );
    return Number(result.rows[0]?.processed_count ?? 0);
  });
}

async function saveBackfillProgress(
  db: WorldModelQueryExecutor,
  scope: WorldModelScope,
  phase: string,
  processed: number,
): Promise<void> {
  const { runWithWorldModelScope } = await import('@/server/world-model/db');
  return runWithWorldModelScope(scope, async () => {
    await db.query(
      `INSERT INTO world_model_rebuild_checkpoints
        (projection_type, user_id, persona_id, workspace_id, phase, processed_count)
       VALUES ('backfill', $1, $2, $3, $4, $5)
       ON CONFLICT (projection_type, user_id, persona_id, workspace_id, phase)
       DO UPDATE SET processed_count = EXCLUDED.processed_count, updated_at = now()`,
      [scope.userId, scope.personaId, scope.workspaceId ?? '', phase, processed],
    );
  });
}

async function runBackfill(options: BackfillOptions): Promise<BackfillStats> {
  const stats: BackfillStats = {
    observationsWritten: 0,
    observationsSkipped: 0,
    assertionsCreated: 0,
    eventsCreated: 0,
    entitiesUpserted: 0,
    tasksMirrored: 0,
    actionAttemptsMirrored: 0,
    errors: [],
    generatedAt: new Date().toISOString(),
    phases: {},
  };

  const scope = parseScope(options.scope);

  console.log('=== World Model Backfill ===');
  console.log(`Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Scope: ${options.scope ?? 'all'}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log(`Resume: ${options.resume}`);
  if (options.timeRange) {
    console.log(`Time range: ${options.timeRange.from} - ${options.timeRange.to}`);
  }
  console.log('');

  try {
    const { getWorldModelConfig } = await import('@/server/world-model/config');
    const config = getWorldModelConfig();

    if (!config.enabled && !config.e2eEnabled) {
      stats.errors.push(
        'World Model is disabled; backfill was not executed. Set WORLD_MODEL_ENABLED=true or WORLD_MODEL_E2E=true.',
      );
      return stats;
    }

    const { getWorldModelDb, runWorldModelMigrations, closeWorldModelDb } =
      await import('@/server/world-model/db');
    await runWorldModelMigrations();

    if (options.dryRun) {
      const sqliteDb = openMessagesDb();
      const missionControlDb = openMissionControlDb();
      const masterDb = openMasterDb();
      const conversationConditions: string[] = ['1=1'];
      const conversationParams: string[] = [];
      if (scope?.userId) {
        conversationConditions.push('c.user_id = ?');
        conversationParams.push(scope.userId);
      }
      if (scope?.personaId) {
        conversationConditions.push('c.persona_id = ?');
        conversationParams.push(scope.personaId);
      }
      if (options.timeRange) {
        conversationConditions.push('m.created_at >= ? AND m.created_at <= ?');
        conversationParams.push(options.timeRange.from, options.timeRange.to);
      }
      const messageCount = sqliteDb
        .prepare(
          `SELECT COUNT(*) AS count FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE ${conversationConditions.join(' AND ')}`,
        )
        .get(...conversationParams) as { count: number };
      const { getKnowledgeRepository } = await import('@/server/knowledge/runtime');
      const knowledgeRepo = getKnowledgeRepository();
      const knowledgeScopes = scope
        ? [{ userId: scope.userId!, personaId: scope.personaId! }]
        : (knowledgeRepo.listKnowledgeScopes?.() ?? []);
      let episodeCount = 0;
      let ledgerCount = 0;
      for (const knowledgeScope of knowledgeScopes) {
        const filter = {
          userId: knowledgeScope.userId,
          personaId: knowledgeScope.personaId,
          from: options.timeRange?.from,
          to: options.timeRange?.to,
          limit: 100_000,
        };
        episodeCount += knowledgeRepo.listEpisodes(filter).length;
        ledgerCount += knowledgeRepo.listMeetingLedger(filter).length;
      }
      const taskQuery = scope
        ? 'SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?'
        : 'SELECT COUNT(*) AS count FROM tasks';
      const taskCount = missionControlDb
        .prepare(taskQuery)
        .get(...(scope ? [scope.workspaceId ?? ''] : [])) as { count: number };
      const actionConditions: string[] = ['1=1'];
      const actionParams: string[] = [];
      if (scope?.userId) {
        actionConditions.push('user_id = ?');
        actionParams.push(scope.userId);
      }
      if (scope?.workspaceId !== undefined) {
        actionConditions.push('workspace_id = ?');
        actionParams.push(scope.workspaceId);
      }
      const actionCount = masterDb
        .prepare(
          `SELECT COUNT(*) AS count FROM master_action_ledger WHERE ${actionConditions.join(' AND ')}`,
        )
        .get(...actionParams) as { count: number };
      stats.phases = {
        messages: { selected: Number(messageCount.count), processed: 0, skipped: 0, failed: 0 },
        knowledgeEpisodes: { selected: episodeCount, processed: 0, skipped: 0, failed: 0 },
        knowledgeLedger: { selected: ledgerCount, processed: 0, skipped: 0, failed: 0 },
        tasks: { selected: Number(taskCount.count), processed: 0, skipped: 0, failed: 0 },
        toolActions: { selected: Number(actionCount.count), processed: 0, skipped: 0, failed: 0 },
      };
      sqliteDb.close();
      missionControlDb.close();
      masterDb.close();
      console.log(`[DRY RUN] Selection: ${JSON.stringify(stats.phases)}`);
      console.log('[DRY RUN] No data was written.');
      return stats;
    }

    const db = getWorldModelDb();
    const sqliteDb = openMessagesDb();
    const missionControlDb = openMissionControlDb();
    const masterDb = openMasterDb();

    // Phase 1: Backfill observations from chat messages.
    console.log('Phase 1: Backfilling observations from chat messages...');
    try {
      const { bridgeChatMessages } = await import('@/server/world-model/bridge');

      const conversationConditions: string[] = ['1=1'];
      const conversationParams: (string | null)[] = [];
      if (scope?.userId) {
        conversationConditions.push('user_id = ?');
        conversationParams.push(scope.userId);
      }
      if (scope?.personaId) {
        conversationConditions.push('persona_id = ?');
        conversationParams.push(scope.personaId);
      }

      const conversationsQuery = `
        SELECT id, channel_type, external_chat_id, user_id, title, created_at, updated_at, persona_id
        FROM conversations
        WHERE ${conversationConditions.join(' AND ')}
        ORDER BY created_at ASC
      `;
      const conversations = sqliteDb
        .prepare(conversationsQuery)
        .all(...conversationParams) as SqliteConversation[];

      console.log(`  -> ${conversations.length} conversation(s) selected for backfill`);

      for (const conversation of conversations) {
        const userId = conversation.user_id;
        const personaId = conversation.persona_id ?? 'default';
        const workspaceId = scope?.workspaceId ?? '';
        const messageScope: WorldModelScope = { userId, personaId, workspaceId };
        let processedSeq = await getBackfillProgress(
          db,
          messageScope,
          `messages:${conversation.id}`,
          options.resume,
        );

        const messageConditions: string[] = ['conversation_id = ?'];
        const messageParams: (string | number | null)[] = [conversation.id];
        if (options.timeRange) {
          messageConditions.push('created_at >= ? AND created_at <= ?');
          messageParams.push(options.timeRange.from, options.timeRange.to);
        }

        const messagesQuery = `
          SELECT id, conversation_id, seq, role, content, platform, external_msg_id, sender_name, metadata, created_at, client_message_id
          FROM messages
          WHERE ${messageConditions.join(' AND ')}
          ORDER BY seq ASC
        `;
        const messages = (
          sqliteDb.prepare(messagesQuery).all(...messageParams) as SqliteMessage[]
        ).filter((message) => Number(message.seq) > processedSeq);

        for (let i = 0; i < messages.length; i += options.batchSize) {
          const batch = messages.slice(i, i + options.batchSize);
          const result = await bridgeChatMessages({
            conversationId: conversation.id,
            userId,
            personaId,
            workspaceId,
            messages: batch.map((message) => ({
              userId,
              personaId,
              conversationId: conversation.id,
              seq: message.seq,
              role: message.role,
              content: message.content,
              createdAt: message.created_at,
              id: message.id,
              sourceId: message.id,
              channelType: conversation.channel_type,
              senderId: message.sender_name ?? undefined,
            })),
          });
          stats.observationsWritten += result.written;
          stats.observationsSkipped += result.skipped;
          processedSeq = Number(batch[batch.length - 1]?.seq ?? processedSeq);
          await saveBackfillProgress(db, messageScope, `messages:${conversation.id}`, processedSeq);
        }
        stats.phases.messages = {
          selected: (stats.phases.messages?.selected ?? 0) + messages.length,
          processed: (stats.phases.messages?.processed ?? 0) + messages.length,
          skipped: stats.phases.messages?.skipped ?? 0,
          failed: stats.phases.messages?.failed ?? 0,
        };
      }

      console.log(
        `  -> ${stats.observationsWritten} observation(s) written, ${stats.observationsSkipped} skipped`,
      );
    } catch (error) {
      stats.phases.messages = {
        ...(stats.phases.messages ?? { selected: 0, processed: 0, skipped: 0 }),
        failed: (stats.phases.messages?.failed ?? 0) + 1,
      };
      stats.errors.push(
        `Observation backfill: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Phase 2: Backfill knowledge artifacts.
    console.log('Phase 2: Backfilling knowledge artifacts...');
    try {
      const { projectWindow } = await import('@/server/world-model/projector/projectWindow');
      const { getKnowledgeRepository } = await import('@/server/knowledge/runtime');
      const knowledgeRepo = getKnowledgeRepository();
      const knowledgeScopes = scope
        ? [{ userId: scope.userId!, personaId: scope.personaId! }]
        : (knowledgeRepo.listKnowledgeScopes?.() ?? []);
      let selected = 0;
      let processed = 0;

      for (const knowledgeScope of knowledgeScopes) {
        const wmScope: WorldModelScope = {
          userId: knowledgeScope.userId,
          personaId: knowledgeScope.personaId,
          workspaceId: scope?.workspaceId ?? '',
        };
        await runWithWorldModelScope(wmScope, async () => {
          const episodePhase = `knowledge:episodes:${knowledgeScope.userId}:${knowledgeScope.personaId}`;
          const ledgerPhase = `knowledge:ledger:${knowledgeScope.userId}:${knowledgeScope.personaId}`;
          let episodeOffset = await getBackfillProgress(db, wmScope, episodePhase, options.resume);
          let ledgerOffset = await getBackfillProgress(db, wmScope, ledgerPhase, options.resume);
          const filter = {
            userId: knowledgeScope.userId,
            personaId: knowledgeScope.personaId,
            from: options.timeRange?.from,
            to: options.timeRange?.to,
            limit: 100_000,
          };
          const episodes = knowledgeRepo.listEpisodes(filter).slice(episodeOffset);
          selected += episodes.length;
          for (const episode of episodes) {
            const sourceSeq = episode.sourceSeqStart;
            const projection = {
              assertions: episode.facts.map((fact, index) => ({
                subject: knowledgeScope.personaId,
                predicate: 'knowledge_fact',
                objectValue: fact,
                modality: 'reported' as const,
                confidence: 0.7,
                sourceMessageSeq: sourceSeq + index,
              })),
              events: episode.eventAt
                ? [
                    {
                      title: episode.teaser || episode.topicKey,
                      eventType: 'knowledge_episode',
                      scheduledFor: episode.eventAt,
                      status: 'planned' as const,
                      sourceMessageSeq: sourceSeq,
                    },
                  ]
                : [],
              entities: episode.counterpart
                ? [
                    {
                      canonicalName: episode.counterpart,
                      category: 'person',
                      owner: 'shared' as const,
                      sourceMessageSeq: sourceSeq,
                    },
                  ]
                : [],
              relations: [],
              openLoops: [],
              tasks: [],
              confidenceSummary: { total: episode.facts.length, confident: 0 },
            };
            const result = await projectWindow({
              scope: wmScope,
              projection,
              observation: {
                ...wmScope,
                sourceType: 'automation',
                sourceId: `backfill:knowledge:episode:${episode.id}`,
                occurredAt: episode.eventAt ?? episode.updatedAt ?? new Date().toISOString(),
                payload: { artifactType: 'knowledge_episode', source: episode },
                sourceAuthority: 'backfill',
              },
            });
            stats.assertionsCreated += result.assertionsCreated;
            stats.eventsCreated += result.eventsCreated;
            stats.entitiesUpserted += result.entitiesUpserted;
            processed += 1;
            episodeOffset += 1;
            await saveBackfillProgress(db, wmScope, episodePhase, episodeOffset);
          }

          const ledger = knowledgeRepo.listMeetingLedger(filter).slice(ledgerOffset);
          selected += ledger.length;
          for (const entry of ledger) {
            const sourceSeq = entry.sourceRefs[0]?.seq ?? 0;
            const projection = {
              assertions: entry.decisions.concat(entry.negotiatedTerms).map((value, index) => ({
                subject: knowledgeScope.personaId,
                predicate: 'meeting_decision',
                objectValue: value,
                modality: 'reported' as const,
                confidence: Math.max(0, Math.min(1, entry.confidence)),
                sourceMessageSeq: sourceSeq + index,
              })),
              events: entry.eventAt
                ? [
                    {
                      title: entry.topicKey,
                      eventType: 'meeting_ledger',
                      scheduledFor: entry.eventAt,
                      status: 'planned' as const,
                      sourceMessageSeq: sourceSeq,
                    },
                  ]
                : [],
              entities: [
                ...entry.participants,
                ...(entry.counterpart ? [entry.counterpart] : []),
              ].map((name) => ({
                canonicalName: name,
                category: 'person',
                owner: 'shared' as const,
                sourceMessageSeq: sourceSeq,
              })),
              relations: [],
              openLoops: entry.openPoints.map((question, index) => ({
                type: 'missing_context' as const,
                question,
                deduplicationKey: question,
                sourceMessageSeq: sourceSeq + index,
              })),
              tasks: entry.actionItems.map((title, index) => ({
                title,
                requester: knowledgeScope.userId,
                assignee: knowledgeScope.personaId,
                sourceMessageSeq: sourceSeq + index,
              })),
              confidenceSummary: {
                total:
                  entry.decisions.length + entry.negotiatedTerms.length + entry.actionItems.length,
                confident: 0,
              },
            };
            const result = await projectWindow({
              scope: wmScope,
              projection,
              observation: {
                ...wmScope,
                sourceType: 'automation',
                sourceId: `backfill:knowledge:ledger:${entry.id}`,
                occurredAt: entry.eventAt ?? entry.updatedAt ?? new Date().toISOString(),
                payload: { artifactType: 'knowledge_meeting_ledger', source: entry },
                sourceAuthority: 'backfill',
              },
            });
            stats.assertionsCreated += result.assertionsCreated;
            stats.eventsCreated += result.eventsCreated;
            stats.entitiesUpserted += result.entitiesUpserted;
            stats.tasksMirrored += entry.actionItems.length;
            processed += 1;
            ledgerOffset += 1;
            await saveBackfillProgress(db, wmScope, ledgerPhase, ledgerOffset);
          }
        });
      }
      stats.phases.knowledge = { selected, processed, skipped: 0, failed: 0 };
      console.log(`  -> ${processed} Knowledge-Artefakt(e) verarbeitet`);
    } catch (error) {
      stats.phases.knowledge = {
        ...(stats.phases.knowledge ?? { selected: 0, processed: 0, skipped: 0 }),
        failed: (stats.phases.knowledge?.failed ?? 0) + 1,
      };
      stats.errors.push(
        `Knowledge backfill: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Phase 3: Mirror existing Mission Control tasks.
    console.log('Phase 3: Mirroring existing Mission Control tasks...');
    try {
      const { insertTask } = await import('@/server/world-model/repositories/taskRepository');
      const { recordObservation } =
        await import('@/server/world-model/services/observationService');
      const { toWorldModelTaskStatus } =
        await import('@/server/world-model/services/missionControlBridge');
      const taskConditions = ['1=1'];
      const taskParams: Array<string> = [];
      if (scope?.workspaceId !== undefined) {
        taskConditions.push('workspace_id = ?');
        taskParams.push(scope.workspaceId);
      }
      if (options.timeRange) {
        taskConditions.push('created_at >= ? AND created_at <= ?');
        taskParams.push(options.timeRange.from, options.timeRange.to);
      }
      const tasks = missionControlDb
        .prepare(
          `SELECT id, title, description, status, assigned_agent_id, workspace_id, due_date, created_at
           FROM tasks WHERE ${taskConditions.join(' AND ')} ORDER BY created_at ASC`,
        )
        .all(...taskParams) as Array<{
        id: string;
        title: string;
        description: string | null;
        status:
          | 'pending_dispatch'
          | 'planning'
          | 'inbox'
          | 'assigned'
          | 'in_progress'
          | 'testing'
          | 'review'
          | 'done';
        assigned_agent_id: string | null;
        workspace_id: string;
        due_date: string | null;
        created_at: string;
      }>;
      const taskScope: WorldModelScope = {
        userId: scope?.userId ?? process.env.WORLD_MODEL_BACKFILL_USER_ID ?? 'default',
        personaId: scope?.personaId ?? process.env.WORLD_MODEL_DEFAULT_PERSONA_ID ?? 'default',
        workspaceId: scope?.workspaceId ?? '',
      };
      const { runWithWorldModelScope } = await import('@/server/world-model/db');
      await runWithWorldModelScope(taskScope, async () => {
        const taskOffset = await getBackfillProgress(db, taskScope, 'tasks', options.resume);
        let processed = 0;
        for (const task of tasks.slice(taskOffset)) {
          const taskWorkspace = task.workspace_id || taskScope.workspaceId || '';
          await runWithWorldModelScope({ ...taskScope, workspaceId: taskWorkspace }, async () => {
            const completedEvidence =
              task.status === 'done'
                ? await recordObservation({
                    ...taskScope,
                    workspaceId: taskWorkspace,
                    sourceType: 'automation',
                    sourceId: `backfill:task-completion:${task.id}`,
                    occurredAt: task.created_at,
                    payload: {
                      artifactType: 'mission_control_task_completion',
                      taskId: task.id,
                      title: task.title,
                    },
                    sourceAuthority: 'backfill',
                  })
                : null;
            const canonicalTask = await insertTask({
              ...taskScope,
              workspaceId: taskWorkspace,
              title: task.title,
              description: task.description ?? undefined,
              requester: taskScope.userId,
              assignee: task.assigned_agent_id ?? taskScope.personaId,
              externalTaskId: task.id,
              origin: 'mission_control_backfill',
              status: toWorldModelTaskStatus(task.status),
              dueAt: task.due_date ?? undefined,
              idempotencyKey: `task-created:${task.id}`,
            });
            if (completedEvidence) {
              await db.query(
                `UPDATE world_model_tasks
                   SET completion_evidence_id = $2,
                       evidence = evidence || $3::jsonb, updated_at = now()
                   WHERE id = $1`,
                [
                  canonicalTask.id,
                  completedEvidence.observation.id,
                  JSON.stringify({ backfill: true }),
                ],
              );
            }
            processed += 1;
            await saveBackfillProgress(db, taskScope, 'tasks', taskOffset + processed);
          });
        }
        stats.tasksMirrored += processed;
        stats.phases.tasks = { selected: tasks.length, processed, skipped: 0, failed: 0 };
        console.log(`  -> ${processed} Mission-Control-Task(s) gespiegelt`);
      });
    } catch (error) {
      stats.phases.tasks = {
        ...(stats.phases.tasks ?? { selected: 0, processed: 0, skipped: 0 }),
        failed: (stats.phases.tasks?.failed ?? 0) + 1,
      };
      stats.errors.push(`Task mirror: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Phase 4: Mirror the master action ledger without executing anything.
    console.log('Phase 4: Mirroring historical tool actions...');
    try {
      const { startActionAttempt, finishActionAttempt } =
        await import('@/server/world-model/repositories/actionAttemptRepository');
      const { recordObservation } =
        await import('@/server/world-model/services/observationService');
      const actionConditions = ['1=1'];
      const actionParams: string[] = [];
      if (scope?.userId) {
        actionConditions.push('user_id = ?');
        actionParams.push(scope.userId);
      }
      if (scope?.workspaceId !== undefined) {
        actionConditions.push('workspace_id = ?');
        actionParams.push(scope.workspaceId);
      }
      if (options.timeRange) {
        actionConditions.push('updated_at >= ? AND updated_at <= ?');
        actionParams.push(options.timeRange.from, options.timeRange.to);
      }
      const ledgerRows = masterDb
        .prepare(
          `SELECT id, run_id, user_id, workspace_id, step_id, action_type,
                  idempotency_key, state, result_payload, updated_at
           FROM master_action_ledger
           WHERE ${actionConditions.join(' AND ')} ORDER BY updated_at ASC`,
        )
        .all(...actionParams) as Array<{
        id: string;
        run_id: string;
        user_id: string;
        workspace_id: string;
        step_id: string;
        action_type: string;
        idempotency_key: string;
        state: string;
        result_payload: string | null;
        updated_at: string;
      }>;
      const actionProgressScope: WorldModelScope = {
        userId: scope?.userId ?? 'backfill-all',
        personaId: scope?.personaId ?? process.env.WORLD_MODEL_DEFAULT_PERSONA_ID ?? 'default',
        workspaceId: scope?.workspaceId ?? '',
      };
      const actionOffset = await getBackfillProgress(
        db,
        actionProgressScope,
        'tool-actions',
        options.resume,
      );
      let processed = 0;
      for (const action of ledgerRows.slice(actionOffset)) {
        const actionScope: WorldModelScope = {
          userId: scope?.userId ?? action.user_id,
          personaId: scope?.personaId ?? process.env.WORLD_MODEL_DEFAULT_PERSONA_ID ?? 'default',
          workspaceId: scope?.workspaceId ?? action.workspace_id ?? '',
        };
        const parsedResult = action.result_payload
          ? (() => {
              try {
                return JSON.parse(action.result_payload) as unknown;
              } catch {
                return action.result_payload;
              }
            })()
          : null;
        await runWithWorldModelScope(actionScope, async () => {
          const observation = await recordObservation({
            ...actionScope,
            sourceType: 'tool_execution',
            sourceId: `backfill:tool:${action.idempotency_key}`,
            occurredAt: action.updated_at,
            payload: {
              artifactType: 'master_action_ledger',
              ledgerId: action.id,
              runId: action.run_id,
              stepId: action.step_id,
              actionType: action.action_type,
              state: action.state,
              result: parsedResult,
            },
            sourceAuthority: 'backfill',
          });
          const attempt = await startActionAttempt({
            scope: actionScope,
            actionType: action.action_type,
            idempotencyKey: `backfill:tool-attempt:${action.idempotency_key}`,
            correlationId: action.run_id,
          });
          if (attempt.created) {
            const terminalStatus =
              action.state === 'succeeded'
                ? 'succeeded'
                : action.state === 'failed'
                  ? 'failed'
                  : 'aborted';
            await finishActionAttempt(attempt.attempt.id, terminalStatus, {
              providerId: 'master_action_ledger',
              target: action.action_type,
              timestamp: action.updated_at,
              payload: {
                ledgerId: action.id,
                observationId: observation.observation.id,
                result: parsedResult,
              },
            });
          }
        });
        processed += 1;
        await saveBackfillProgress(
          db,
          actionProgressScope,
          'tool-actions',
          actionOffset + processed,
        );
      }
      stats.actionAttemptsMirrored += processed;
      stats.phases.toolActions = {
        selected: ledgerRows.length,
        processed,
        skipped: 0,
        failed: 0,
      };
      console.log(`  -> ${processed} Tool-Aktion(en) gespiegelt`);
    } catch (error) {
      stats.phases.toolActions = {
        ...(stats.phases.toolActions ?? { selected: 0, processed: 0, skipped: 0 }),
        failed: (stats.phases.toolActions?.failed ?? 0) + 1,
      };
      stats.errors.push(
        `Tool action backfill: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    sqliteDb.close();
    missionControlDb.close();
    masterDb.close();
    await closeWorldModelDb().catch(() => {});
    console.log('');
    console.log('Backfill complete. Run with real data sources for production backfill.');
  } catch (error) {
    stats.errors.push(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Backfill failed:', error);
  }

  return stats;
}

// Run
const options = parseArgs();
void runBackfill(options).then((stats) => {
  console.log('');
  console.log('=== Backfill Summary ===');
  console.log(
    `Observations: ${stats.observationsWritten} written, ${stats.observationsSkipped} skipped`,
  );
  console.log(`Assertions: ${stats.assertionsCreated} created`);
  console.log(`Events: ${stats.eventsCreated} created`);
  console.log(`Entities: ${stats.entitiesUpserted} upserted`);
  console.log(`Tasks: ${stats.tasksMirrored} mirrored`);
  console.log(`Tool actions: ${stats.actionAttemptsMirrored} mirrored`);
  console.log(`Errors: ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log('Error details:');
    for (const error of stats.errors) {
      console.log(`  - ${error}`);
    }
  }
  if (options.output) {
    fs.writeFileSync(
      options.output,
      JSON.stringify(
        {
          generatedAt: stats.generatedAt,
          options,
          stats,
        },
        null,
        2,
      ),
    );
    console.log(`Report written to ${options.output}`);
  }
  process.exit(stats.errors.length > 0 ? 1 : 0);
});
