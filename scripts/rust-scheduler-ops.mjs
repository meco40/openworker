#!/usr/bin/env node
/**
 * Runs a World-Model operations subcommand of the Rust scheduler binary, with the
 * same `.env.local` loading the TypeScript scripts had:
 *
 *   node scripts/rust-scheduler-ops.mjs migrate
 *   node scripts/rust-scheduler-ops.mjs provision-roles -- --apply
 *   node scripts/rust-scheduler-ops.mjs backfill --dry-run
 *
 * The binary reads only the process environment. This wrapper loads `.env.local`
 * with `@next/env` (as `scripts/dev-stack-rust.mjs` does; values already set in the
 * shell win), builds `betaclaw-scheduler` and runs it. The arguments are
 * passed through unchanged. The exit status is the status of the binary.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(repoRoot);

const subcommandArgs = process.argv.slice(2);
if (subcommandArgs.length === 0) {
  console.error(
    'usage: node scripts/rust-scheduler-ops.mjs <migrate|provision-roles|verify-rls|reconcile|rebuild-projections|backfill|workspaces-cleanup|attachments-consistency|knowledge-ingest|memory-reset|memory-cleanup-noise|memory-backfill-channel-scope|memory-migrate-to-postgres|graphiti-evaluate|drill> [args]',
  );
  process.exit(2);
}

// Build inside `rust/` so rustup applies `rust/rust-toolchain.toml` (from the
// repository root, `--manifest-path` would use the host default toolchain). The
// binary then runs from the repository root, where its relative data paths
// (`.local/...`) resolve as before.
const rustDir = resolve(repoRoot, 'rust');
const build = spawnSync('cargo', ['build', '--locked', '--bin', 'betaclaw-scheduler'], {
  cwd: rustDir,
  env: process.env,
  stdio: 'inherit',
});
if (build.error) {
  console.error(`could not start cargo: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const binary = resolve(
  rustDir,
  'target',
  'debug',
  process.platform === 'win32' ? 'betaclaw-scheduler.exe' : 'betaclaw-scheduler',
);
const result = spawnSync(binary, subcommandArgs, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`could not start ${binary}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
