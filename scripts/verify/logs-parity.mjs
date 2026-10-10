#!/usr/bin/env node
/**
 * Cross-implementation parity check for the migrated `/api/logs` surface.
 *
 * Both implementations run against the same SQLite file. The Rust gateway runs
 * in a container, the TypeScript route runs in-process against a temporary
 * database with the same schema, and both responses are compared field by field.
 *
 * Fields that are intentionally volatile (ids, timestamps, cursors) are
 * normalised before comparison; everything else must match exactly.
 *
 *   node scripts/verify/logs-parity.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTAINER = process.env.GATEWAY_CONTAINER || 'betaclaw-gateway-ws';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${label}`);
    console.log(`     Rust: ${JSON.stringify(actual)}`);
    console.log(`     TS  : ${JSON.stringify(expected)}`);
  } else {
    console.log(`OK   ${label} = ${JSON.stringify(actual)}`);
  }
  return ok;
}

/** Replaces volatile values so only the contract is compared. */
function normaliseLog(entry) {
  return {
    level: entry.level,
    source: entry.source,
    category: entry.category,
    message: entry.message,
    metadata: entry.metadata ?? null,
    hasId: typeof entry.id === 'string' && entry.id.length > 0,
    hasTimestamp: typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)),
    createdAtMatchesTimestamp: entry.createdAt === entry.timestamp,
  };
}

async function curlInContainer(args) {
  const output = execFileSync('docker', ['exec', CONTAINER, 'curl', '-s', ...args], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return JSON.parse(output);
}

// ── Reference implementation ───────────────────────────────────
// The TypeScript repository, exercised through the same log repository the
// route handler uses.
async function typescriptLog(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-'));
  const dbPath = join(dir, 'logs.db');
  process.env.LOGS_DB_PATH = dbPath;
  const { LogRepository } = await import('../../src/logging/logRepository.ts');
  const { logFromSystemEvent } = await import('../../src/logging/logService.ts');

  const repo = new LogRepository(dbPath);
  for (const { type, message } of entries) {
    logFromSystemEvent(type, message);
  }

  const listed = repo.listLogs({ limit: 200 });
  const total = repo.getLogCount({});
  const sources = repo.getSources();
  const categories = repo.getCategories();
  const cleared = repo.clearLogs();
  // Both this repository and the process-global one opened the file, so both
  // connections have to be closed before Windows releases the file.
  repo.close();
  const { getLogRepository } = await import('../../src/logging/logRepository.ts');
  const singleton = getLogRepository();
  if (singleton !== repo) singleton.close();

  const result = { listed, total, sources, categories, cleared };
  // Cleanup is best effort: a leftover temp directory must not fail the check.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // Windows may keep the handle until process exit.
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return result;
}

// ── Rust implementation ────────────────────────────────────────
async function rustLog(entries) {
  // Start from a known state: earlier smoke runs may have left entries behind.
  await curlInContainer(['-X', 'DELETE', 'http://127.0.0.1:3000/api/logs']);

  for (const { type, message } of entries) {
    await curlInContainer([
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ type, message }),
      'http://127.0.0.1:3000/api/logs/ingest',
    ]);
  }

  const listed = await curlInContainer(['http://127.0.0.1:3000/api/logs?limit=200']);
  const sources = await curlInContainer(['http://127.0.0.1:3000/api/logs?sources']);
  const categories = await curlInContainer(['http://127.0.0.1:3000/api/logs?categories']);
  const cleared = await curlInContainer(['-X', 'DELETE', 'http://127.0.0.1:3000/api/logs']);

  return {
    listed: listed.logs,
    total: listed.total,
    sources: sources.sources,
    categories: categories.categories,
    cleared: cleared.deleted,
  };
}

const ENTRIES = [
  { type: 'AUTH', message: 'login failed for user@example.com' },
  { type: 'SYS', message: 'gateway started' },
  { type: 'TOOL', message: 'shell command timed out' },
  { type: 'MEM', message: 'embedding queue warning' },
  { type: 'CHAN', message: 'channel.inbound.accepted:telegram' },
  { type: 'UNKNOWN_TYPE', message: 'plain informational message' },
  { type: 'SYS', message: 'connection LOST' },
  { type: 'TASK', message: 'queue spike detected' },
];

async function main() {
  console.log('=== /api/logs Parität Rust <-> TypeScript ===\n');

  const ts = await typescriptLog(ENTRIES);
  const rust = await rustLog(ENTRIES);

  console.log('--- Anzahl ---');
  check('Einträge', rust.listed.length, ts.listed.length);
  check('total', rust.total, ts.total);

  console.log('\n--- Inhalt (normalisiert) ---');
  const rustEntries = rust.listed.map(normaliseLog);
  const tsEntries = ts.listed.map(normaliseLog);
  for (let index = 0; index < Math.max(rustEntries.length, tsEntries.length); index += 1) {
    check(`Eintrag ${index}`, rustEntries[index], tsEntries[index]);
  }

  console.log('\n--- Sources und Kategorien ---');
  check('sources', [...rust.sources].sort(), [...ts.sources].sort());
  check('categories', [...rust.categories].sort(), [...ts.categories].sort());

  console.log('\n--- clear() ---');
  check('gelöschte Einträge', rust.cleared, ts.cleared);

  console.log(failures === 0 ? '\nLOG-PARITÄT VOLLSTÄNDIG' : `\n${failures} ABWEICHUNG(EN)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
