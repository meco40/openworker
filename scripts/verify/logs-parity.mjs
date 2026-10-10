#!/usr/bin/env node
/**
 * Cross-implementation parity check for the migrated `/api/logs` surface.
 *
 * Thin wrapper around the parity harness; the family logic lives in
 * `parity/families/logs.mjs`. Both implementations are compared field by
 * field, with volatile values normalised away.
 *
 *   node scripts/verify/logs-parity.mjs
 */
import { run } from './parity/families/logs.mjs';
import { failureCount } from './parity/harness.mjs';

await run();

if (failureCount() > 0) {
  console.error(`\n${failureCount()} ABWEICHUNG(EN)`);
  process.exit(1);
}
console.log('\nLOG-PARITÄT VOLLSTÄNDIG');
