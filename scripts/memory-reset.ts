import fs from 'node:fs';
import nextEnv from '@next/env';

import BetterSqlite3 from 'better-sqlite3';

import { LEGACY_LOCAL_USER_ID } from '../src/server/auth/constants';
import { createMem0ClientFromEnv, type Mem0Client } from '../src/server/memory/mem0Client';

const DEFAULT_MESSAGES_DB_PATH = '.local/messages.db';
const DEFAULT_PERSONAS_DB_PATH = '.local/personas.db';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

type ScopeSummary = {
  users: string[];
  personas: string[];
};

type LocalResetSummary = {
  before: number;
  deleted: number;
  remaining: number;
};

type Mem0ResetSummary = {
  deleted: number;
  checkedScopes: number;
  nonEmptyScopes: Array<{ userId: string; personaId: string; remaining: number }>;
};

function hasTable(db: BetterSqlite3.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function collectScopes(messagesDbPath: string, personasDbPath: string): ScopeSummary {
  const users = new Set<string>([LEGACY_LOCAL_USER_ID]);
  const personas = new Set<string>();

  if (fs.existsSync(personasDbPath)) {
    const db = new BetterSqlite3(personasDbPath, { readonly: true });
    try {
      if (hasTable(db, 'personas')) {
        const rows = db
          .prepare('SELECT id, user_id as userId FROM personas')
          .all() as Array<{ id: string; userId: string }>;
        for (const row of rows) {
          if (row.id) personas.add(String(row.id));
          if (row.userId) users.add(String(row.userId));
        }
      }
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(messagesDbPath)) {
    const db = new BetterSqlite3(messagesDbPath, { readonly: true });
    try {
      if (hasTable(db, 'conversations')) {
        const rows = db
          .prepare('SELECT user_id as userId, persona_id as personaId FROM conversations')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) {
          if (row.userId) users.add(String(row.userId));
          if (row.personaId) personas.add(String(row.personaId));
        }
      }
      if (hasTable(db, 'memory_nodes')) {
        const rows = db
          .prepare('SELECT user_id as userId, persona_id as personaId FROM memory_nodes')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) {
          if (row.userId) users.add(String(row.userId));
          if (row.personaId) personas.add(String(row.personaId));
        }
      }
    } finally {
      db.close();
    }
  }

  return {
    users: Array.from(users).filter(Boolean),
    personas: Array.from(personas).filter(Boolean),
  };
}

function resetLocalMemory(messagesDbPath: string): LocalResetSummary {
  if (!fs.existsSync(messagesDbPath)) {
    return { before: 0, deleted: 0, remaining: 0 };
  }

  const db = new BetterSqlite3(messagesDbPath);
  db.pragma('busy_timeout = 8000');
  try {
    if (!hasTable(db, 'memory_nodes')) {
      return { before: 0, deleted: 0, remaining: 0 };
    }

    const before = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as { c: number }).c;
    const deleted = db.prepare('DELETE FROM memory_nodes').run().changes;
    const remaining = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as { c: number }).c;
    return { before, deleted, remaining };
  } finally {
    db.close();
  }
}

async function resetMem0(client: Mem0Client, scopes: ScopeSummary): Promise<Mem0ResetSummary> {
  let deleted = 0;
  let checkedScopes = 0;
  const nonEmptyScopes: Array<{ userId: string; personaId: string; remaining: number }> = [];
  const errors: string[] = [];

  for (const userId of scopes.users) {
    for (const personaId of scopes.personas) {
      checkedScopes += 1;
      try {
        deleted += await client.deleteMemoriesByFilter({ userId, personaId });
        const listed = await client.listMemories({
          userId,
          personaId,
          page: 1,
          pageSize: 1,
        });
        if (listed.total > 0) {
          nonEmptyScopes.push({ userId, personaId, remaining: listed.total });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`[${userId}/${personaId}] ${message}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Mem0 reset failed for ${errors.length} scope(s): ${errors.join(' | ')}`);
  }

  return { deleted, checkedScopes, nonEmptyScopes };
}

async function main(): Promise<void> {
  const messagesDbPath = process.env.MESSAGES_DB_PATH || DEFAULT_MESSAGES_DB_PATH;
  const personasDbPath = process.env.PERSONAS_DB_PATH || DEFAULT_PERSONAS_DB_PATH;
  const scopes = collectScopes(messagesDbPath, personasDbPath);
  if (scopes.personas.length === 0) {
    throw new Error('No personas available for mem0 reset scope discovery.');
  }

  const local = resetLocalMemory(messagesDbPath);
  const mem0Client = createMem0ClientFromEnv(process.env, fetch);
  if (!mem0Client) {
    throw new Error(
      'Mem0 not configured. Set MEMORY_PROVIDER=mem0 and MEM0_BASE_URL before running memory reset.',
    );
  }

  const mem0 = await resetMem0(mem0Client, scopes);

  if (mem0.nonEmptyScopes.length > 0) {
    throw new Error(
      `Mem0 reset incomplete: ${mem0.nonEmptyScopes.length} scope(s) still contain memory.`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        messagesDbPath,
        personasDbPath,
        scopes,
        local,
        mem0,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
