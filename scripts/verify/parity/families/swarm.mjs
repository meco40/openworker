/**
 * Agent-room swarm trace.
 *
 * The Rust tick test asserts the trace fixture `rust/crates/betaclaw-gateway/tests/fixtures/swarm-parity.json`.
 * This family checks that the fixture still equals the reference recorded from the
 * TypeScript orchestrator (`golden/swarm.json`). It runs no TypeScript itself.
 */
import { check, goldenReference } from '../harness.mjs';
import { readFileSync } from 'node:fs';

export const name = 'swarm';

const TRACE_FIXTURE = new URL(
  '../../../../rust/crates/betaclaw-gateway/tests/fixtures/swarm-parity.json',
  import.meta.url,
);

export async function run() {
  const trace = JSON.parse(readFileSync(TRACE_FIXTURE, 'utf8'));
  for (const key of ['dispatch', 'commands', 'completion']) {
    check(`Trace ${key}`, trace[key], await goldenReference(name, key));
  }
}
