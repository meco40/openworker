/** The shared trace is asserted by Rust's real tick test and the actual TS orchestrator. */
import { spawnSync } from 'node:child_process';
export const name = 'swarm';
export async function run() {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--project=core-isolated',
      'tests/integration/agent-room-rust-parity.test.ts',
    ],
    { stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0) throw new Error('Rust/TypeScript swarm trace differs.');
}
