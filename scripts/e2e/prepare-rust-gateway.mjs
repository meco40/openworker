#!/usr/bin/env node
/**
 * Builds the Rust gateway and scheduler the E2E lanes start (debug profile, incremental).
 * Run before `test:e2e:smoke` and `test:e2e:browser`; a no-op when nothing changed.
 *
 * Without cargo (the container lanes in docker-compose.e2e.yml) the binaries that the
 * `e2e-rust-build` service left in rust/target/debug are used when both exist.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BINARIES = ['betaclaw-gateway', 'betaclaw-scheduler'];
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const debugDir = path.resolve(import.meta.dirname, '..', '..', 'rust', 'target', 'debug');
const missing = BINARIES.filter((name) => !fs.existsSync(path.join(debugDir, exe(name))));

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).error) {
  if (missing.length === 0) {
    console.log(`[e2e] cargo not found; using the prebuilt binaries in ${debugDir}`);
    process.exit(0);
  }
  console.error(
    `[e2e] cargo is required for the E2E lanes, or prebuilt binaries in ${debugDir} (missing: ${missing.join(', ')})`,
  );
  process.exit(1);
}

// Run cargo inside `rust/` so rustup applies `rust/rust-toolchain.toml`; with
// `--manifest-path` from the repository root it would use the host default toolchain
// and rebuild the shared target directory with a different compiler.
const result = spawnSync(
  'cargo',
  ['build', '--locked', '--bin', 'betaclaw-gateway', '--bin', 'betaclaw-scheduler'],
  { cwd: path.resolve(debugDir, '..', '..'), stdio: 'inherit' },
);
process.exit(result.status ?? 1);
