/**
 * Knowledge Cleanup: Entity Drift, Stale Relative Time, Placeholder & Low-Relevance Detection
 *
 * Scans all Mem0 memories for problems detected by cleanupDetector:
 * - Placeholder entities ("die Figur" instead of real names)
 * - Stale relative times ("morgen" from 2 weeks ago)
 * - Low-relevance content (greetings, short acks)
 *
 * Usage:
 *   npx tsx scripts/knowledge-cleanup-entity-drift.ts               # dry-run
 *   npx tsx scripts/knowledge-cleanup-entity-drift.ts --apply        # actually delete
 *   npx tsx scripts/knowledge-cleanup-entity-drift.ts --persona Nata # filter by persona
 *   npx tsx scripts/knowledge-cleanup-entity-drift.ts --max-delete 50
 */

import fs from 'node:fs';
import { loadEnvConfig } from '@next/env';
import BetterSqlite3 from 'better-sqlite3';

import { LEGACY_LOCAL_USER_ID } from '../src/server/auth/constants';
import {
  detectPlaceholder,
  detectStaleRelativeTime,
  detectLowRelevance,
} from '../src/server/knowledge/cleanupDetector';
import {
  createMem0ClientFromEnv,
  type Mem0Client,
  type Mem0MemoryRecord,
} from '../src/server/memory/mem0Client';

const DEFAULT_MESSAGES_DB_PATH = '.local/messages.db';
const DEFAULT_PERSONAS_DB_PATH = '.local/personas.db';
const PAGE_SIZE = 200;

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

interface CleanupCandidate {
  userId: string;
  personaId: string;
  id: string;
  content: string;
  reason: string;
  createdAt: string;
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
    }
  }
  return options;
}

function loadScopePairs(options: CliOptions): ScopePair[] {
  const messagesPath = process.env.MESSAGES_DB_PATH || DEFAULT_MESSAGES_DB_PATH;
  const personasPath = process.env.PERSONAS_DB_PATH || DEFAULT_PERSONAS_DB_PATH;

  const personaIds: string[] = [];

  if (fs.existsSync(personasPath)) {
    const pDb = new BetterSqlite3(personasPath, { readonly: true });
    try {
      const rows = pDb.prepare('SELECT id FROM personas').all() as Array<{ id: string }>;
      personaIds.push(...rows.map((row) => row.id));
    } finally {
      pDb.close();
    }
  }

  if (personaIds.length === 0 && fs.existsSync(messagesPath)) {
    const mDb = new BetterSqlite3(messagesPath, { readonly: true });
    try {
      const rows = mDb
        .prepare('SELECT DISTINCT persona_id FROM conversations WHERE persona_id IS NOT NULL')
        .all() as Array<{ persona_id: string }>;
      personaIds.push(...rows.map((row) => row.persona_id));
    } finally {
      mDb.close();
    }
  }

  if (personaIds.length === 0) {
    console.warn('[cleanup] No personas found. Nothing to scan.');
    return [];
  }

  const userId = options.userFilter || LEGACY_LOCAL_USER_ID;

  return personaIds
    .filter((pid) => !options.personaFilter || pid.includes(options.personaFilter))
    .map((personaId) => ({ userId, personaId }));
}

function classifyMemory(
  record: Mem0MemoryRecord,
  userId: string,
  personaId: string,
): CleanupCandidate | null {
  const content = String(record.content || '').trim();
  const createdAt = String(record.createdAt || record.updatedAt || '');

  if (!content) return null;

  if (detectPlaceholder(content)) {
    return { userId, personaId, id: record.id, content, reason: 'placeholder_entity', createdAt };
  }

  if (createdAt && detectStaleRelativeTime(content, createdAt)) {
    return {
      userId,
      personaId,
      id: record.id,
      content,
      reason: 'stale_relative_time',
      createdAt,
    };
  }

  if (detectLowRelevance(content)) {
    return { userId, personaId, id: record.id, content, reason: 'low_relevance', createdAt };
  }

  return null;
}

async function scanScope(client: Mem0Client, scope: ScopePair): Promise<CleanupCandidate[]> {
  const candidates: CleanupCandidate[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await client.listMemories({
      userId: scope.userId,
      personaId: scope.personaId,
      page,
      pageSize: PAGE_SIZE,
    });

    for (const record of result.memories) {
      const candidate = classifyMemory(record, scope.userId, scope.personaId);
      if (candidate) candidates.push(candidate);
    }

    hasMore = result.memories.length >= PAGE_SIZE;
    page += 1;
  }

  return candidates;
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  const options = parseArgs(process.argv.slice(2));
  const scopes = loadScopePairs(options);

  if (scopes.length === 0) {
    console.log('[cleanup] No scopes to process.');
    return;
  }

  console.log(
    `[cleanup] Scanning ${scopes.length} scope(s) for entity drift, stale times, and low relevance...`,
  );
  console.log(`[cleanup] Mode: ${options.apply ? 'APPLY (will delete)' : 'DRY-RUN (read-only)'}`);

  const client = createMem0ClientFromEnv();
  if (!client) {
    console.error('[cleanup] Could not create Mem0 client. Check env config.');
    return;
  }
  const allCandidates: CleanupCandidate[] = [];

  for (const scope of scopes) {
    const candidates = await scanScope(client, scope);
    allCandidates.push(...candidates);
    if (candidates.length > 0) {
      console.log(`  ${scope.personaId}: ${candidates.length} cleanup candidates`);
    }
  }

  if (allCandidates.length === 0) {
    console.log('[cleanup] No cleanup candidates found. All clean!');
    return;
  }

  // Group by reason for summary
  const byReason = new Map<string, CleanupCandidate[]>();
  for (const candidate of allCandidates) {
    const list = byReason.get(candidate.reason) || [];
    list.push(candidate);
    byReason.set(candidate.reason, list);
  }

  console.log(`\n[cleanup] Summary: ${allCandidates.length} total candidates`);
  for (const [reason, items] of byReason) {
    console.log(`  ${reason}: ${items.length}`);
    for (const item of items.slice(0, 5)) {
      const preview = item.content.length > 60 ? `${item.content.slice(0, 57)}...` : item.content;
      console.log(`    - [${item.personaId}] "${preview}"`);
    }
    if (items.length > 5) {
      console.log(`    ... and ${items.length - 5} more`);
    }
  }

  if (!options.apply) {
    console.log('\n[cleanup] Dry run complete. Use --apply to delete flagged memories.');
    return;
  }

  const maxDelete = options.maxDelete || allCandidates.length;
  const toDelete = allCandidates.slice(0, maxDelete);
  let deleted = 0;
  let failed = 0;

  for (const candidate of toDelete) {
    try {
      await client.deleteMemory(candidate.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `  [FAIL] Could not delete ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`\n[cleanup] Deleted ${deleted} memories (${failed} failures).`);
}

main().catch((error) => {
  console.error('[cleanup] Fatal error:', error);
  process.exit(1);
});
