/**
 * Trigger Knowledge Ingestion — Manual one-shot run
 *
 * Instantiates the full ingestion pipeline (cursor, extractor, repository,
 * memory service) and calls `runOnce()` to process all pending conversation
 * windows — exactly what the scheduler does, but on-demand from the CLI.
 *
 * Prerequisites:
 *   - Model Hub has at least one active model with profile `p1`
 *   - GEMINI_API_KEY (or equivalent) is set
 *   - Mem0 is reachable (MEM0_API_KEY or local docker)
 *   - .env has KNOWLEDGE_LAYER_ENABLED=true + KNOWLEDGE_EPISODE_ENABLED=true
 *
 * Usage:
 *   npx tsx scripts/trigger-knowledge-ingestion.ts               # full run (all pending)
 *   npx tsx scripts/trigger-knowledge-ingestion.ts --dry-run     # show pending windows only
 *   npx tsx scripts/trigger-knowledge-ingestion.ts --persona Lea # filter by persona name
 *   npx tsx scripts/trigger-knowledge-ingestion.ts --limit 5     # max N conversations
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import {
  getKnowledgeIngestionService,
  getKnowledgeIngestionCursor,
  getKnowledgeRepository,
} from '../src/server/knowledge/runtime';
import { resolveKnowledgeConfig } from '../src/server/knowledge/config';

// ── Persona name resolution ─────────────────────────────────

function loadPersonaNameMap(): Map<string, string> {
  const dbPath = process.env.PERSONAS_DB_PATH || '.local/personas.db';
  const map = new Map<string, string>();
  if (!fs.existsSync(dbPath)) return map;
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id, name FROM personas').all() as Array<{
      id: string;
      name: string;
    }>;
    for (const row of rows) map.set(row.id, row.name);
  } finally {
    db.close();
  }
  return map;
}

// ── CLI Parsing ──────────────────────────────────────────────

interface CliOptions {
  dryRun: boolean;
  personaFilter?: string;
  limit: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, limit: 200 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--persona') {
      options.personaFilter = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.floor(parsed);
      }
      index += 1;
    }
  }
  return options;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // ── Config check ───────────────────────────────────────────
  const config = resolveKnowledgeConfig();
  console.log('\n[knowledge-ingestion] Configuration:');
  console.log(`  layerEnabled     = ${config.layerEnabled}`);
  console.log(`  episodeEnabled   = ${config.episodeEnabled}`);
  console.log(`  ledgerEnabled    = ${config.ledgerEnabled}`);
  console.log(`  contradictionDet = ${config.contradictionDetectionEnabled}`);
  console.log(`  ingestIntervalMs = ${config.ingestIntervalMs}`);

  if (!config.layerEnabled) {
    console.error(
      '\n[knowledge-ingestion] KNOWLEDGE_LAYER_ENABLED is false. Set it to true in .env and retry.',
    );
    process.exit(1);
  }
  if (!config.episodeEnabled && !config.ledgerEnabled) {
    console.error(
      '\n[knowledge-ingestion] Neither KNOWLEDGE_EPISODE_ENABLED nor KNOWLEDGE_LEDGER_ENABLED is true. Enable at least one.',
    );
    process.exit(1);
  }

  // ── Discover pending windows ───────────────────────────────
  const personaNames = loadPersonaNameMap();
  const cursor = getKnowledgeIngestionCursor();
  const allWindows = cursor.getPendingWindows(options.limit);

  const windows = options.personaFilter
    ? allWindows.filter((window) => {
        const name = personaNames.get(window.personaId) || '';
        const needle = options.personaFilter!.toLowerCase();
        return (
          window.personaId.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)
        );
      })
    : allWindows;

  console.log(`\n[knowledge-ingestion] Found ${windows.length} pending conversation window(s):`);
  for (const window of windows) {
    const name = personaNames.get(window.personaId) || '?';
    console.log(
      `  • ${window.conversationId}  persona=${name} (${window.personaId})  msgs=${window.messages.length}  seq=${window.fromSeqExclusive + 1}..${window.toSeqInclusive}`,
    );
  }

  if (windows.length === 0) {
    console.log('\n[knowledge-ingestion] Nothing to ingest. All conversations are up to date.');
    process.exit(0);
  }

  if (options.dryRun) {
    console.log('\n[knowledge-ingestion] --dry-run active. Exiting without changes.');
    process.exit(0);
  }

  // ── Run ingestion ──────────────────────────────────────────
  console.log('\n[knowledge-ingestion] Starting ingestion...\n');
  const service = getKnowledgeIngestionService();

  // If persona filter is active, ingest individual windows instead of runOnce
  if (options.personaFilter) {
    let ok = 0;
    let fail = 0;
    for (const window of windows) {
      try {
        await service.ingestConversationWindow({
          conversationId: window.conversationId,
          userId: window.userId,
          personaId: window.personaId,
          messages: window.messages,
        });
        cursor.markWindowProcessed(window);
        ok += 1;
        console.log(
          `  ✓ ${window.conversationId} (${window.messages.length} messages, persona=${window.personaId})`,
        );
      } catch (error) {
        fail += 1;
        console.error(
          `  ✗ ${window.conversationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    console.log(`\n[knowledge-ingestion] Done. ok=${ok} failed=${fail}`);
  } else {
    const result = await service.runOnce();
    console.log(
      `\n[knowledge-ingestion] Done. conversations=${result.processedConversations} messages=${result.processedMessages} errors=${result.errors.length}`,
    );
    if (result.errors.length > 0) {
      console.log('\nErrors:');
      for (const err of result.errors) {
        console.log(`  ✗ ${err.conversationId} (${err.personaId}): ${err.reason}`);
      }
    }
  }

  // ── Summary of stored data ─────────────────────────────────
  try {
    const repo = getKnowledgeRepository();
    const episodes = repo.listEpisodes({ userId: '', personaId: '', limit: 1000 });
    const ledger = repo.listMeetingLedger({ userId: '', personaId: '', limit: 1000 });
    console.log(
      `\n[knowledge-ingestion] Repository totals: episodes=${episodes.length} ledger=${ledger.length}`,
    );
  } catch {
    // listEpisodes may need userId/personaId — not critical
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('[knowledge-ingestion] Fatal error:', error);
  process.exit(1);
});
