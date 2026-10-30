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
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { failureCount } from './harness.mjs';

const familiesDir = fileURLToPath(new URL('./families', import.meta.url));
const filter = (process.argv.find((argument) => argument.startsWith('--family=')) ?? '').slice(
  '--family='.length,
);
const explicitlyRequestedPrivateFamily = filter.startsWith('_') ? `${filter}.mjs` : null;

const families = [];
for (const file of readdirSync(familiesDir)
  .filter(
    (name) =>
      name.endsWith('.mjs') && (!name.startsWith('_') || name === explicitlyRequestedPrivateFamily),
  )
  .sort()) {
  // Import through a `file://` URL: a bare Windows path (`E:\...`) is rejected
  // by the ESM loader, so discovery must not depend on the host OS.
  const family = await import(pathToFileURL(join(familiesDir, file)).href);
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

if (!filter) {
  console.log(`=== Routen-Parität Rust <-> TypeScript (${target}) ===`);
  let totalFailures = 0;
  for (const family of families) {
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), `--family=${family.name}`],
      { stdio: 'inherit', env: process.env },
    );
    if (result.status !== 0) totalFailures += 1;
  }
  if (totalFailures > 0) {
    console.error(`\n${totalFailures} FAMILIE(N) MIT ABWEICHUNG(EN)`);
    process.exit(1);
  }
  console.log('\nPARITÄT VOLLSTÄNDIG');
  process.exit(0);
}

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
