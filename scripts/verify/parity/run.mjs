#!/usr/bin/env node
/**
 * Runs the cross-implementation parity families against a running Rust gateway.
 *
 *   node --import tsx scripts/verify/parity/run.mjs                # all families
 *   node --import tsx scripts/verify/parity/run.mjs --family=logs  # one family
 *
 * The gateway is expected under `GATEWAY_BASE_URL` (CI: started release binary)
 * or as `GATEWAY_CONTAINER` (documented local docker flow, default
 * `betaclaw-gateway-ws`). Every migrated route family must have a family here;
 * CI runs all of them, so a slice is only done when its family is green.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureCount } from './harness.mjs';

const familiesDir = fileURLToPath(new URL('./families', import.meta.url));
const filter = (process.argv.find((argument) => argument.startsWith('--family=')) ?? '').slice(
  '--family='.length,
);

const families = [];
for (const file of readdirSync(familiesDir)
  .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
  .sort()) {
  const family = await import(join(familiesDir, file));
  if (filter && family.name !== filter) continue;
  families.push(family);
}

if (families.length === 0) {
  console.error(filter ? `Keine Paritätsfamilie '${filter}'.` : 'Keine Paritätsfamilien gefunden.');
  process.exit(2);
}

const target = process.env.GATEWAY_BASE_URL
  ? `Gateway unter ${process.env.GATEWAY_BASE_URL}`
  : `Container ${process.env.GATEWAY_CONTAINER || 'betaclaw-gateway-ws'}`;
console.log(`=== Routen-Parität Rust <-> TypeScript (${target}) ===`);

for (const family of families) {
  console.log(`\n--- Familie: ${family.name} ---\n`);
  await family.run();
}

if (failureCount() > 0) {
  console.error(`\n${failureCount()} ABWEICHUNG(EN)`);
  process.exit(1);
}
console.log('\nPARITÄT VOLLSTÄNDIG');
