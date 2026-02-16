import fs from 'node:fs';
import nextEnv from '@next/env';
import BetterSqlite3 from 'better-sqlite3';

import { LEGACY_LOCAL_USER_ID } from '../src/server/auth/constants';
import { isNoiseMemoryFact } from '../src/server/knowledge/textQuality';
import {
  createMem0ClientFromEnv,
  type Mem0Client,
  type Mem0MemoryRecord,
} from '../src/server/memory/mem0Client';

const DEFAULT_MESSAGES_DB_PATH = '.local/messages.db';
const DEFAULT_PERSONAS_DB_PATH = '.local/personas.db';
const PAGE_SIZE = 200;
const { loadEnvConfig } = nextEnv;

interface CliOptions {
  apply: boolean;
  personaFilter?: string;
  userFilter?: string;
  maxDelete?: number;
}

interface ScopePair {
  userId: string;
  personaId: string;
}

interface NoiseCandidate {
  userId: string;
  personaId: string;
  id: string;
  content: string;
  reason: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--persona') {
      options.personaFilter = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--user') {
      options.userFilter = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--max-delete') {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.maxDelete = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node --import tsx scripts/memory-cleanup-noise.ts [--apply] [--persona <id|name>] [--user <userId>] [--max-delete <n>]',
          '',
          'Defaults to dry-run. Use --apply to delete matched memories.',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return options;
}

function hasTable(db: BetterSqlite3.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 as ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok?: number } | undefined;
  return row?.ok === 1;
}

function selectPersonaIds(personasDbPath: string, messagesDbPath: string, filter?: string): Set<string> {
  const personaIds = new Set<string>();
  const trimmedFilter = String(filter || '').trim();

  if (fs.existsSync(personasDbPath)) {
    const db = new BetterSqlite3(personasDbPath, { readonly: true });
    try {
      if (hasTable(db, 'personas')) {
        if (trimmedFilter) {
          const rows = db
            .prepare('SELECT id FROM personas WHERE id = ? OR lower(name) LIKE lower(?)')
            .all(trimmedFilter, `%${trimmedFilter}%`) as Array<{ id: string }>;
          for (const row of rows) {
            if (row.id) personaIds.add(String(row.id));
          }
        } else {
          const rows = db.prepare('SELECT id FROM personas').all() as Array<{ id: string }>;
          for (const row of rows) {
            if (row.id) personaIds.add(String(row.id));
          }
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
        const rows = trimmedFilter
          ? (db
              .prepare('SELECT DISTINCT persona_id as personaId FROM conversations WHERE persona_id = ?')
              .all(trimmedFilter) as Array<{ personaId: string | null }>)
          : (db.prepare('SELECT DISTINCT persona_id as personaId FROM conversations').all() as Array<{
              personaId: string | null;
            }>);
        for (const row of rows) {
          if (row.personaId) personaIds.add(String(row.personaId));
        }
      }
    } finally {
      db.close();
    }
  }

  if (trimmedFilter && personaIds.size === 0) {
    // allow explicit id usage even if it is not in local sqlite indices
    personaIds.add(trimmedFilter);
  }

  return personaIds;
}

function collectScopePairs(
  messagesDbPath: string,
  personaIds: Set<string>,
  userFilter?: string,
): ScopePair[] {
  const pairs = new Map<string, ScopePair>();
  const userFilterTrimmed = String(userFilter || '').trim();
  const personaFilterSet = personaIds;

  const maybeAddPair = (userIdRaw: unknown, personaIdRaw: unknown): void => {
    const userId = String(userIdRaw || '').trim();
    const personaId = String(personaIdRaw || '').trim();
    if (!userId || !personaId) return;
    if (userFilterTrimmed && userId !== userFilterTrimmed) return;
    if (personaFilterSet.size > 0 && !personaFilterSet.has(personaId)) return;
    pairs.set(`${userId}::${personaId}`, { userId, personaId });
  };

  if (fs.existsSync(messagesDbPath)) {
    const db = new BetterSqlite3(messagesDbPath, { readonly: true });
    try {
      if (hasTable(db, 'conversations')) {
        const rows = db
          .prepare('SELECT DISTINCT user_id as userId, persona_id as personaId FROM conversations')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) maybeAddPair(row.userId, row.personaId);
      }
      if (hasTable(db, 'knowledge_episodes')) {
        const rows = db
          .prepare('SELECT DISTINCT user_id as userId, persona_id as personaId FROM knowledge_episodes')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) maybeAddPair(row.userId, row.personaId);
      }
      if (hasTable(db, 'knowledge_meeting_ledger')) {
        const rows = db
          .prepare('SELECT DISTINCT user_id as userId, persona_id as personaId FROM knowledge_meeting_ledger')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) maybeAddPair(row.userId, row.personaId);
      }
      if (hasTable(db, 'memory_nodes')) {
        const rows = db
          .prepare('SELECT DISTINCT user_id as userId, persona_id as personaId FROM memory_nodes')
          .all() as Array<{ userId: string | null; personaId: string | null }>;
        for (const row of rows) maybeAddPair(row.userId, row.personaId);
      }
    } finally {
      db.close();
    }
  }

  // legacy fallback scope for selected personas
  for (const personaId of personaFilterSet) {
    maybeAddPair(userFilterTrimmed || LEGACY_LOCAL_USER_ID, personaId);
  }

  return Array.from(pairs.values());
}

function classifyNoiseReason(record: Mem0MemoryRecord): string | null {
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {};
  const type = String(metadata.type || '').trim().toLowerCase();
  const sourceType = String(metadata.sourceType || '').trim().toLowerCase();
  const artifactType = String(metadata.artifactType || '').trim().toLowerCase();
  const content = String(record.content || '').trim();

  if (artifactType === 'teaser' || artifactType === 'episode') {
    return `artifact:${artifactType}`;
  }

  if (type && type !== 'fact') return null;
  if (isNoiseMemoryFact(content)) return 'noise-fact-text';
  if (sourceType === 'knowledge_ingestion' && content.length > 500) return 'oversized-ingestion-fact';

  return null;
}

async function collectNoiseCandidates(mem0: Mem0Client, pair: ScopePair): Promise<NoiseCandidate[]> {
  const found: NoiseCandidate[] = [];
  let page = 1;

  while (true) {
    const listed = await mem0.listMemories({
      userId: pair.userId,
      personaId: pair.personaId,
      page,
      pageSize: PAGE_SIZE,
    });

    for (const memory of listed.memories) {
      const reason = classifyNoiseReason(memory);
      if (!reason) continue;
      found.push({
        userId: pair.userId,
        personaId: pair.personaId,
        id: memory.id,
        content: String(memory.content || '').replace(/\s+/g, ' ').trim(),
        reason,
      });
    }

    const reachedEnd = page * PAGE_SIZE >= listed.total || listed.memories.length === 0;
    if (reachedEnd) break;
    page += 1;
  }

  return found;
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const options = parseArgs(process.argv.slice(2));

  const messagesDbPath = process.env.MESSAGES_DB_PATH || DEFAULT_MESSAGES_DB_PATH;
  const personasDbPath = process.env.PERSONAS_DB_PATH || DEFAULT_PERSONAS_DB_PATH;
  const mem0 = createMem0ClientFromEnv(process.env, fetch);
  if (!mem0) {
    throw new Error('Mem0 not configured. Set MEMORY_PROVIDER=mem0 and MEM0_* env vars.');
  }

  const personaIds = selectPersonaIds(personasDbPath, messagesDbPath, options.personaFilter);
  if (personaIds.size === 0) {
    throw new Error('No persona scopes found for cleanup.');
  }
  const pairs = collectScopePairs(messagesDbPath, personaIds, options.userFilter);
  if (pairs.length === 0) {
    throw new Error('No user/persona scope pairs found for cleanup.');
  }

  const allCandidates: NoiseCandidate[] = [];
  for (const pair of pairs) {
    const pairCandidates = await collectNoiseCandidates(mem0, pair);
    allCandidates.push(...pairCandidates);
  }

  const uniqueCandidates = Array.from(
    new Map(allCandidates.map((entry) => [entry.id, entry])).values(),
  );

  const planned =
    options.maxDelete && options.maxDelete > 0
      ? uniqueCandidates.slice(0, options.maxDelete)
      : uniqueCandidates;

  let deleted = 0;
  const deleteErrors: Array<{ id: string; reason: string }> = [];
  if (options.apply) {
    for (const candidate of planned) {
      try {
        await mem0.deleteMemory(candidate.id);
        deleted += 1;
      } catch (error) {
        deleteErrors.push({
          id: candidate.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = {
    ok: deleteErrors.length === 0,
    mode: options.apply ? 'apply' : 'dry-run',
    filters: {
      persona: options.personaFilter || null,
      user: options.userFilter || null,
      maxDelete: options.maxDelete || null,
    },
    scopePairs: pairs,
    scannedCandidates: uniqueCandidates.length,
    plannedDeletes: planned.length,
    deleted,
    deleteErrors,
    sample: planned.slice(0, 25).map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      personaId: entry.personaId,
      reason: entry.reason,
      content: entry.content.slice(0, 200),
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
});
