/**
 * `/api/logs` parity: ingest, listing, sources, categories and clear.
 *
 * The TypeScript side drives the same LogRepository the route delegates to,
 * in-process against a temporary database. The Rust side goes over HTTP
 * against a running gateway. Volatile fields (ids, timestamps) are normalised
 * before comparison; everything else must match exactly.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'logs';

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

async function typescriptLog(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-'));
  const dbPath = join(dir, 'logs.db');
  process.env.LOGS_DB_PATH = dbPath;
  const { LogRepository, getLogRepository } =
    await import('../../../../src/logging/logRepository.ts');
  const { logFromSystemEvent } = await import('../../../../src/logging/logService.ts');

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
  const singleton = getLogRepository();
  if (singleton !== repo) singleton.close();

  const result = { listed, total, sources, categories, cleared };
  bestEffortRemoveDir(dir);
  return result;
}

async function rustLog(entries) {
  // Start from a known state: earlier smoke runs may have left entries behind.
  await rustRequest('DELETE', '/api/logs');

  for (const { type, message } of entries) {
    await rustRequest('POST', '/api/logs/ingest', { body: { type, message } });
  }

  const listed = await rustRequest('GET', '/api/logs?limit=200');
  const sources = await rustRequest('GET', '/api/logs?sources');
  const categories = await rustRequest('GET', '/api/logs?categories');
  const cleared = await rustRequest('DELETE', '/api/logs');

  return {
    listed: listed.json.logs,
    total: listed.json.total,
    sources: sources.json.sources,
    categories: categories.json.categories,
    cleared: cleared.json.deleted,
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

export async function run() {
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
}
