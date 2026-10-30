#!/usr/bin/env node
/**
 * Copies the Node-era data from the host `.local` directory into the Docker volume the
 * Rust dev gateway uses (`betaclaw-dev-data` -> /app/.local).
 *
 * - Personas, conversations and master runs owned by `legacy-local-user` are re-keyed to
 *   the admin account the gateway seeds from AUTH_DEFAULT_*, so the admin session sees them.
 * - Model-hub accounts are global. Their secrets stay encrypted with the
 *   MODEL_HUB_ENCRYPTION_KEY from .env.local, which the dev stack passes by name.
 * - The host files are read through SQLite's backup API and are never written to.
 *
 * Run it with the dev stack stopped: pnpm run dev:import-legacy
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(repoRoot);
const Database = require('better-sqlite3');

// Same volume as scripts/dev-stack-rust.mjs mounts at /app/.local.
const DEV_DATA_VOLUME = 'betaclaw-dev-data';
const GATEWAY_IMAGE = 'betaclaw-gateway-local';
const SEED_CONTAINER = 'betaclaw-legacy-seed';
const LEGACY_USER_ID = 'legacy-local-user';
const LEGACY_DIR = path.join(repoRoot, '.local');
// host file -> file name inside the volume (the gateway reads messages.db by default)
const COPIES = [
  ['personas.db', 'personas.db'],
  ['messages.recovered.db', 'messages.db'],
  ['master.db', 'master.db'],
  ['model-hub.db', 'model-hub.db'],
];
const SEED_ENV_NAMES = [
  'NEXTAUTH_SECRET',
  'AUTH_DEFAULT_EMAIL',
  'AUTH_DEFAULT_PASSWORD',
  'AUTH_DEFAULT_NAME',
  'MODEL_HUB_ENCRYPTION_KEY',
];

function docker(args, { capture = 'utf8' } = {}) {
  const result = spawnSync('docker', args, {
    encoding: capture,
    maxBuffer: 512 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || '')
      .trim()
      .slice(0, 400);
    throw new Error(`docker ${args[0]} exited ${result.status}: ${stderr}`);
  }
  return result.stdout;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDevGatewayStopped() {
  const running = docker([
    'ps',
    '--filter',
    'name=^betaclaw-dev-gateway$',
    '--format',
    '{{.Names}}',
  ]);
  if (running.trim()) {
    throw new Error('betaclaw-dev-gateway is running. Stop the dev stack first.');
  }
}

/** Starts the gateway once on the volume so it creates and seeds the admin account. */
function seedVolume() {
  try {
    docker(['rm', '-f', SEED_CONTAINER]);
  } catch {
    // no leftover seed container
  }
  docker(['volume', 'create', DEV_DATA_VOLUME]);
  const args = [
    'run',
    '-d',
    '--name',
    SEED_CONTAINER,
    '-v',
    `${DEV_DATA_VOLUME}:/app/.local`,
    '-e',
    'PORT=3000',
    '-e',
    'HOSTNAME=0.0.0.0',
    '-e',
    'RUST_LOG=warn',
    '-e',
    'NODE_ENV=development',
    '-e',
    'REQUIRE_AUTH=false',
    '-e',
    'WORKSPACE_ROOT=/app',
    '-e',
    'CLAWHUB_WORKDIR=/app/clawhub',
    '-e',
    'EXTERNAL_SKILLS_ENABLED=false',
    ...SEED_ENV_NAMES.flatMap((name) => ['-e', name]),
    GATEWAY_IMAGE,
  ];
  docker(args);
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const code = docker([
          'exec',
          SEED_CONTAINER,
          'sh',
          '-c',
          'curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/__rust/health',
        ]).trim();
        if (code === '200') return;
      } catch {
        // container not answering yet
      }
      sleepMs(1000);
    }
    throw new Error('seed gateway did not become healthy');
  } finally {
    docker(['rm', '-f', SEED_CONTAINER]);
  }
}

/** Copies a file from the volume; a missing file yields an empty buffer. */
function readVolumeFile(name) {
  return docker(
    [
      'run',
      '--rm',
      '-v',
      `${DEV_DATA_VOLUME}:/src:ro`,
      'alpine',
      'sh',
      '-c',
      `test -f /src/${name} && cat /src/${name} || true`,
    ],
    { capture: 'buffer' },
  );
}

/** Reads the admin id from the seeded auth store, including its WAL. */
function readAdminId(workDir) {
  const base = 'auth.db';
  for (const name of [base, `${base}-wal`, `${base}-shm`]) {
    fs.writeFileSync(path.join(workDir, name), readVolumeFile(name));
  }
  const email = (process.env.AUTH_DEFAULT_EMAIL || '').trim().toLowerCase();
  const db = new Database(path.join(workDir, base), { readonly: true, fileMustExist: true });
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

/** Backs up one host database and re-keys the legacy user rows in the copy. */
async function copyWithRekey(sourceName, targetName, adminId, workDir) {
  const source = new Database(path.join(LEGACY_DIR, sourceName), {
    readonly: true,
    fileMustExist: true,
  });
  const target = path.join(workDir, targetName);
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

/** Replaces the seeded files in the volume and drops their stale WAL and SHM files. */
function copyIntoVolume(workDir) {
  const names = COPIES.map(([, target]) => target);
  const copies = names.map((name) => `cp /src/${name} /dst/${name}`);
  // The gateway runs as its own user; files copied as root must get its owner back,
  // otherwise SQLite reports "attempt to write a readonly database".
  const owner = 'OWNER=$(stat -c %u:%g /dst)';
  const chown = names.map((name) => `chown "$OWNER" /dst/${name}`);
  const stale = names.flatMap((name) => [`/dst/${name}-wal`, `/dst/${name}-shm`]);
  const script = [owner, ...copies, ...chown, `rm -f ${stale.join(' ')}`].join(' && ');
  docker([
    'run',
    '--rm',
    '-v',
    `${DEV_DATA_VOLUME}:/dst`,
    '-v',
    `${workDir.replace(/\\/g, '/')}:/src:ro`,
    'alpine',
    'sh',
    '-c',
    script,
  ]);
}

async function main() {
  ensureDevGatewayStopped();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betaclaw-legacy-'));
  try {
    seedVolume();
    const adminId = readAdminId(workDir);
    console.log(`admin id in volume: ${adminId}`);
    for (const [source, target] of COPIES) {
      const changed = await copyWithRekey(source, target, adminId, workDir);
      const summary = Object.keys(changed).length
        ? Object.entries(changed)
            .map(([table, count]) => `${table}=${count}`)
            .join(' ')
        : 'no legacy rows';
      console.log(`${source} -> ${target}: re-keyed ${summary}`);
    }
    copyIntoVolume(workDir);
    console.log(`volume ${DEV_DATA_VOLUME} filled. Start the dev stack with: pnpm run dev`);
  } finally {
    // The temporary copies contain the stored secrets; remove them.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
