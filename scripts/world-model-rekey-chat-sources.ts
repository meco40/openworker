#!/usr/bin/env node
/**
 * Rekey legacy chat observations to the persisted SQLite message id.
 *
 * This is a one-time, scoped maintenance operation for databases created
 * before live ingestion and backfill shared the same source identity.
 *
 * Usage:
 *   pnpm run world-model:rekey-chat-sources -- --scope user:persona:workspace --dry-run
 *   pnpm run world-model:rekey-chat-sources -- --scope user:persona:workspace --apply
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  closeWorldModelDb,
  getWorldModelDb,
  runWithWorldModelScope,
  withWorldModelTransaction,
} from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

interface LegacyMessage {
  id: string;
  conversation_id: string;
  seq: number;
}

interface ChatObservation {
  id: string;
  source_id: string;
  conversation_id: string | null;
  seq: number | null;
}

function parseArgs(): { scope: WorldModelScope; apply: boolean } {
  const args = process.argv.slice(2);
  const scopeValue = args[args.indexOf('--scope') + 1];
  if (!scopeValue || scopeValue.startsWith('--')) {
    throw new Error('--scope userId:personaId:workspaceId is required');
  }
  const parts = scopeValue.split(':');
  if (parts.length < 3) throw new Error('--scope userId:personaId:workspaceId is required');
  return {
    scope: {
      userId: parts[0]!,
      personaId: parts[1]!,
      workspaceId: parts.slice(2).join(':'),
    },
    apply: args.includes('--apply'),
  };
}

function buildMessageIndex(scope: WorldModelScope): Map<string, string> {
  const dbPath = process.env.MESSAGES_DB_PATH || path.resolve('.local/messages.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.seq
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ? AND c.persona_id = ?
          ORDER BY m.created_at, m.seq`,
      )
      .all(scope.userId, scope.personaId) as LegacyMessage[];
    return new Map(rows.map((row) => [`${row.conversation_id}:${row.seq}`, row.id]));
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const { scope, apply } = parseArgs();
  const messageIndex = buildMessageIndex(scope);

  const result = await runWithWorldModelScope(scope, async () => {
    const db = getWorldModelDb();
    const observations = (
      await db.query<ChatObservation>(
        `SELECT id, source_id, payload->>'conversationId' AS conversation_id,
                (payload->>'seq')::integer AS seq
           FROM world_model_observations
          WHERE source_type = 'chat_message'
          ORDER BY received_at`,
      )
    ).rows;

    const changes = observations.flatMap((observation) => {
      const key =
        observation.conversation_id && observation.seq !== null
          ? `${observation.conversation_id}:${observation.seq}`
          : null;
      const targetSourceId = key ? messageIndex.get(key) : undefined;
      if (!targetSourceId || targetSourceId === observation.source_id) return [];
      return [{ observation, targetSourceId }];
    });

    if (!apply) {
      const targetSourceIds = [...new Set(changes.map((change) => change.targetSourceId))];
      const existingCanonical = targetSourceIds.length
        ? await db.query<{ source_id: string }>(
            `SELECT source_id
               FROM world_model_observations
              WHERE source_type = 'chat_message' AND source_id = ANY($1::text[])`,
            [targetSourceIds],
          )
        : { rows: [] };
      return {
        scope,
        apply: false,
        observations: observations.length,
        rekeyed: changes.length,
        duplicateRows: 0,
        potentialDuplicateRows: existingCanonical.rows.length,
      };
    }

    let rekeyed = 0;
    let duplicateRows = 0;
    await withWorldModelTransaction(async (client) => {
      for (const change of changes) {
        const canonical = await client.query<{ id: string }>(
          `SELECT id
             FROM world_model_observations
            WHERE source_type = 'chat_message' AND source_id = $1`,
          [change.targetSourceId],
        );
        const canonicalId = canonical.rows[0]?.id;
        if (canonicalId && canonicalId !== change.observation.id) {
          const references = [
            ['world_model_assertions', 'source_observation_id'],
            ['world_model_event_transitions', 'source_observation_id'],
            ['world_model_tasks', 'request_observation_id'],
            ['world_model_task_transitions', 'source_observation_id'],
            ['world_model_entity_relations', 'source_observation_id'],
            ['world_model_projection_pending', 'source_observation_id'],
            ['world_model_ingestion_checkpoints', 'committed_observation_id'],
            ['world_model_open_loops', 'resolved_observation_id'],
          ] as const;
          for (const [table, column] of references) {
            await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [
              canonicalId,
              change.observation.id,
            ]);
          }
          await client.query(
            `UPDATE world_model_outbox_events
                SET aggregate_id = $1
              WHERE aggregate_id = $2`,
            [canonicalId, change.observation.id],
          );
          await client.query(
            `DELETE FROM world_model_embeddings
              WHERE target_type = 'observation' AND target_id = $1`,
            [change.observation.id],
          );
          await client.query('DELETE FROM world_model_observations WHERE id = $1', [
            change.observation.id,
          ]);
          duplicateRows += 1;
        } else {
          await client.query('UPDATE world_model_observations SET source_id = $1 WHERE id = $2', [
            change.targetSourceId,
            change.observation.id,
          ]);
        }
        rekeyed += 1;
      }
    }, scope);

    return {
      scope,
      apply: true,
      observations: observations.length,
      rekeyed,
      duplicateRows,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await closeWorldModelDb();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeWorldModelDb();
  process.exitCode = 1;
});
