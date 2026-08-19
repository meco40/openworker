import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
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
export function listRuntimeWorldModelScopes(): WorldModelScope[] {
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

  const seen = new Set<string>();
  return candidates.filter((scope) => {
    const key = `${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
