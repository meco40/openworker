import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getWorldModelDb } from '@/server/world-model/db';
import type { WorldModelScope } from '@/server/world-model/scope';

function parseConfiguredScopes(): WorldModelScope[] {
  return String(process.env.WORLD_MODEL_DISPATCH_SCOPES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      const parts = value.split(':');
      if (parts.length < 3 || !parts[0] || !parts[1]) return [];
      return [{ userId: parts[0], personaId: parts[1], workspaceId: parts.slice(2).join(':') }];
    });
}

/**
 * Finds runtime scopes without bypassing World-Model RLS. The legacy message
 * store is the authoritative scope registry for chat-backed tenants; an env
 * allowlist covers scopes that only contain scheduled or operational data.
 */
export async function listRuntimeWorldModelScopes(): Promise<WorldModelScope[]> {
  const candidates = [...parseConfiguredScopes()];
  const dbPath = process.env.MESSAGES_DB_PATH || path.resolve('.local/messages.db');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT user_id, persona_id
             FROM conversations
            WHERE user_id IS NOT NULL AND persona_id IS NOT NULL`,
        )
        .all() as Array<{ user_id: string; persona_id: string }>;
      candidates.push(
        ...rows.map((row) => ({ userId: row.user_id, personaId: row.persona_id, workspaceId: '' })),
      );
    } finally {
      db.close();
    }
  }

  // Local development commonly uses the migration/admin connection, where
  // the canonical tables are visible without a tenant session. Dedicated
  // worker roles intentionally see no rows for this unscoped query; their
  // explicit WORLD_MODEL_DISPATCH_SCOPES remain the safe discovery path.
  try {
    const db = getWorldModelDb();
    const rows = await db.query<{ user_id: string; persona_id: string; workspace_id: string }>(
      `SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_memory_items
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_events
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks`,
    );
    candidates.push(
      ...rows.rows.map((row) => ({
        userId: row.user_id,
        personaId: row.persona_id,
        workspaceId: row.workspace_id,
      })),
    );
  } catch (error) {
    console.warn('[world-model:scope-discovery] canonical scope scan unavailable:', error);
  }

  const seen = new Set<string>();
  return candidates.filter((scope) => {
    const key = `${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
