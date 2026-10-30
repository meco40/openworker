import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Data stores of the host gateway (`rust/target/release/betaclaw-gateway.exe`).
 *
 * They live in their own copy under `.local/rust-dev`. The Node-era files directly in
 * `.local` stay untouched, because Rust migrations would write into them. Used by
 * scripts/dev-stack-rust.mjs and scripts/dev-import-legacy.mjs.
 */
const require = createRequire(import.meta.url);

export const RUST_DEV_DATA_SUBDIR = path.join('.local', 'rust-dev');

export const HOST_DATA_FILES = {
  AUTH_DB_PATH: 'auth.db',
  AUTOMATION_DB_PATH: 'automation.db',
  CLAWHUB_DB_PATH: 'clawhub.db',
  GATEWAY_CONFIG_DB_PATH: 'gateway-config.db',
  KNOWLEDGE_DB_PATH: 'messages.db',
  LOGS_DB_PATH: 'logs.db',
  MASTER_DB_PATH: 'master.db',
  MEMORY_DB_PATH: 'memory.db',
  MESSAGES_DB_PATH: 'messages.db',
  MODEL_HUB_DB_PATH: 'model-hub.db',
  PERSONAS_DB_PATH: 'personas.db',
  PROACTIVE_DB_PATH: 'proactive.db',
  SKILLS_DB_PATH: 'skills.db',
  SQLITE_DB_PATH: 'skills.db',
  STATS_DB_PATH: 'stats.db',
};

/**
 * The principal for requests without a session (loopback, dev). It is the admin account
 * of the host store, so the data re-keyed to that account is visible without login.
 * Empty until the gateway has seeded the admin.
 */
function devPrincipalEnv(dir, env) {
  const email = (env.AUTH_DEFAULT_EMAIL || '').trim().toLowerCase();
  const authFile = path.join(dir, 'auth.db');
  if (!email || !fs.existsSync(authFile)) return {};
  const Database = require('better-sqlite3');
  const db = new Database(authFile, { readonly: true, fileMustExist: true });
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
      if (row) return { PRINCIPAL_USER_ID: row.id };
    }
  } finally {
    db.close();
  }
  return {};
}

/** Environment that points every Rust store at the host copy. Overrides .env.local. */
export function hostDataEnv(repoRoot, env = process.env) {
  const dir = path.join(repoRoot, RUST_DEV_DATA_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const stores = Object.fromEntries(
    Object.entries(HOST_DATA_FILES).map(([name, file]) => [name, path.join(dir, file)]),
  );
  return { ...stores, ...devPrincipalEnv(dir, env) };
}
