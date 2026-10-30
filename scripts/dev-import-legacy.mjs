#!/usr/bin/env node
/**
 * Copies the Node-era data from the host `.local` directory into the stores the host
 * gateway uses (`.local/rust-dev`, see scripts/dev-host-data.mjs).
 *
 * - Personas, conversations and master runs owned by `legacy-local-user` are re-keyed to
 *   the admin account the gateway seeds from AUTH_DEFAULT_*, so the admin session sees them.
 * - Model-hub accounts are global. Their secrets stay encrypted with the
 *   MODEL_HUB_ENCRYPTION_KEY from .env.local, which the gateway reads from the environment.
 * - The files directly in `.local` are read through SQLite's backup API and never written.
 *
 * Run it with the dev stack stopped: pnpm run dev:import-legacy
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { hostDataEnv } from './dev-host-data.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(repoRoot);
const Database = require('better-sqlite3');

const GATEWAY_BINARY = path.join(
  repoRoot,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'betaclaw-gateway.exe' : 'betaclaw-gateway',
);
const GATEWAY_PORT = 3000;
const LEGACY_USER_ID = 'legacy-local-user';
const LEGACY_DIR = path.join(repoRoot, '.local');
const TARGET_DIR = path.join(repoRoot, '.local', 'rust-dev');
// host file -> file name in the host gateway's data directory
const COPIES = [
  ['personas.db', 'personas.db'],
  ['messages.recovered.db', 'messages.db'],
  ['master.db', 'master.db'],
  ['model-hub.db', 'model-hub.db'],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isGatewayHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/__rust/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the host gateway once with the host data directory, so it creates and seeds the
 * admin account, then stops it again.
 */
async function seedHostStores() {
  if (await isGatewayHealthy()) {
    throw new Error(
      `a gateway already answers on 127.0.0.1:${GATEWAY_PORT}. Stop the dev stack first.`,
    );
  }
  const child = spawn(GATEWAY_BINARY, [], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...hostDataEnv(repoRoot),
      PORT: String(GATEWAY_PORT),
      HOSTNAME: '127.0.0.1',
      GATEWAY_UPSTREAM_ORIGIN: 'http://127.0.0.1:3001',
      RUST_LOG: 'warn',
    },
  });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await isGatewayHealthy()) return;
      if (child.exitCode !== null) break;
      await sleep(1000);
    }
    throw new Error('seed gateway did not become healthy');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

/** Reads the admin id from the seeded auth store, including its WAL. */
function readAdminId() {
  const email = (process.env.AUTH_DEFAULT_EMAIL || '').trim().toLowerCase();
  const db = new Database(path.join(TARGET_DIR, 'auth.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((column) => column.name);
      if (!columns.includes('id') || !columns.includes('email')) continue;
      const row = db.prepare(`SELECT id FROM "${table}" WHERE lower(email) = ?`).get(email);
      if (row) return row.id;
    }
  } finally {
    db.close();
  }
  throw new Error('admin account from AUTH_DEFAULT_EMAIL not found in the seeded auth store');
}

/** Backs up one legacy database into the host data directory and re-keys the legacy rows. */
async function copyWithRekey(sourceName, targetName, adminId) {
  const target = path.join(TARGET_DIR, targetName);
  // The seed run created these files; the copy replaces them without WAL/SHM leftovers.
  for (const name of [targetName, `${targetName}-wal`, `${targetName}-shm`]) {
    fs.rmSync(path.join(TARGET_DIR, name), { force: true });
  }
  const source = new Database(path.join(LEGACY_DIR, sourceName), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(target);
  } finally {
    source.close();
  }
  const copy = new Database(target);
  const changed = {};
  try {
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    for (const table of tables) {
      const columns = copy
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((column) => column.name);
      if (!columns.includes('user_id')) continue;
      const result = copy
        .prepare(`UPDATE "${table}" SET user_id = ? WHERE user_id = ?`)
        .run(adminId, LEGACY_USER_ID);
      if (result.changes > 0) changed[table] = result.changes;
    }
  } finally {
    copy.close();
  }
  return changed;
}

async function main() {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  await seedHostStores();
  const adminId = readAdminId();
  console.log(`admin id: ${adminId}`);
  for (const [source, target] of COPIES) {
    const changed = await copyWithRekey(source, target, adminId);
    const summary = Object.keys(changed).length
      ? Object.entries(changed)
          .map(([table, count]) => `${table}=${count}`)
          .join(' ')
      : 'no legacy rows';
    console.log(`${source} -> .local/rust-dev/${target}: re-keyed ${summary}`);
  }
  console.log('host data ready. Start the dev stack with: pnpm run dev');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
