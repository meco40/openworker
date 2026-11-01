/**
 * `/api/config` parity: load with redaction, revision-guarded save, secret
 * restore on round-trip, persistence, stale-revision conflict and validation
 * errors.
 *
 * The reference is `golden/config.json`, recorded from the TypeScript config routes
 * before their removal; the Rust side goes over HTTP. The gateway must start from the
 * default config: the documented container flow creates a fresh container per run, CI
 * points `GATEWAY_CONFIG_DB_PATH` at a fresh file.
 *
 * The flow is state-neutral: the mutated config from step 2 is restored in
 * step 4, so the family can also run against a long-lived gateway.
 */
import {
  check,
  checkTrue,
  goldenReference,
  rustRequest,
  bestEffortRemoveDir,
} from '../harness.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const name = 'config';

/** The response shape of GET /api/config. */
/** `rustRequest` returns `{ status, json, text }`; the comparisons read `body`. */
async function withBody(promise) {
  const response = await promise;
  return { status: response.status, body: response.json };
}

function rustGet() {
  return withBody(rustRequest('GET', '/api/config'));
}

async function rustPut(config, revision, { raw } = {}) {
  if (raw !== undefined) {
    return withBody(rustRequest('PUT', '/api/config', { raw }));
  }
  const body = revision === undefined ? { config } : { config, revision };
  return withBody(rustRequest('PUT', '/api/config', { body }));
}

function mutate(config) {
  const next = JSON.parse(JSON.stringify(config));
  next.gateway.logLevel = 'debug';
  return next;
}

function compareLoad(label, rust, ts) {
  check(`${label}: status`, rust.status, ts.status);
  check(`${label}: config`, rust.body?.config, ts.body?.config);
  check(`${label}: source`, rust.body?.source, ts.body?.source);
  check(`${label}: warnings`, rust.body?.warnings, ts.body?.warnings);
  check(`${label}: revision`, rust.body?.revision, ts.body?.revision);
  checkTrue(
    `${label}: displayPath ist ein nicht-leerer String`,
    typeof rust.body?.displayPath === 'string' &&
      rust.body.displayPath.length > 0 &&
      typeof ts.body?.displayPath === 'string' &&
      ts.body.displayPath.length > 0,
  );
}

export async function run() {
  // The gateway resolves its config database from the environment at
  // call time, so the temp path can be set right before the flow starts.
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-config-'));
  process.env.GATEWAY_CONFIG_DB_PATH = join(dir, 'gateway-config.db');
  process.env.BETACLAW_CONFIG_BACKEND = 'db';

  try {
    console.log('--- GET (Default) ---');
    const initialTs = await goldenReference(name, 'GET initial');
    const initialRust = await rustGet();
    compareLoad('GET', initialRust, initialTs);

    const mutatedRust = mutate(initialRust.body.config);

    console.log('\n--- PUT (mutiert, mit Revision) ---');
    const savedTs = await goldenReference(name, 'PUT mutated');
    const savedRust = await rustPut(mutatedRust, initialRust.body.revision);
    check('PUT status', savedRust.status, savedTs.status);
    check('PUT config', savedRust.body?.config, savedTs.body?.config);
    check('PUT revision', savedRust.body?.revision, savedTs.body?.revision);

    console.log('\n--- GET (Persistenz der Mutation) ---');
    const persistedTs = await goldenReference(name, 'GET persisted');
    const persistedRust = await rustGet();
    checkTrue(
      'TS: Mutation persistiert',
      JSON.stringify(persistedTs.body.config) === JSON.stringify(savedTs.body.config),
    );
    checkTrue(
      'Rust: Mutation persistiert',
      JSON.stringify(persistedRust.body.config) === JSON.stringify(savedRust.body.config),
    );
    check('Revision nach Persistenz', persistedRust.body?.revision, persistedTs.body?.revision);

    console.log('\n--- PUT (Restore der redigierten Originalkonfiguration) ---');
    const restoredTs = await goldenReference(name, 'PUT restore');
    const restoredRust = await rustPut(initialRust.body.config, savedRust.body.revision);
    check('Restore status', restoredRust.status, restoredTs.status);
    check('Restore revision', restoredRust.body?.revision, restoredTs.body?.revision);

    console.log('\n--- PUT (veraltete Revision) ---');
    const staleTs = await goldenReference(name, 'PUT stale revision');
    const staleRust = await rustPut(mutatedRust, 'stale-parity-revision');
    check('Stale status', staleRust.status, staleTs.status);
    check('Stale code', staleRust.body?.code, staleTs.body?.code);
    check(
      'Stale currentRevision ist die aktuelle',
      staleRust.body?.currentRevision,
      restoredRust.body?.revision,
    );
    check(
      'Stale currentRevision (TS) ist die aktuelle',
      staleTs.body?.currentRevision,
      restoredTs.body?.revision,
    );

    console.log('\n--- PUT (fehlende Revision) ---');
    const noRevisionTs = await goldenReference(name, 'PUT without revision');
    const noRevisionRust = await rustPut(mutatedRust);
    check('Fehlende Revision status', noRevisionRust.status, noRevisionTs.status);
    check('Fehlende Revision code', noRevisionRust.body?.code, noRevisionTs.body?.code);

    console.log('\n--- PUT (config-Feld fehlt) ---');
    const noConfigTs = await goldenReference(name, 'PUT without config');
    const noConfigRust = await rustPut(undefined, 'irrelevant');
    check('Config fehlt status', noConfigRust.status, noConfigTs.status);
    check('Config fehlt code', noConfigRust.body?.code, noConfigTs.body?.code);

    console.log('\n--- PUT (ungültiges JSON) ---');
    const invalidTs = await goldenReference(name, 'PUT invalid JSON');
    const invalidRust = await rustPut(undefined, undefined, { raw: '{invalid' });
    check('Ungültiges JSON status', invalidRust.status, invalidTs.status);
    check('Ungültiges JSON code', invalidRust.body?.code, invalidTs.body?.code);
  } finally {
    bestEffortRemoveDir(dir);
  }
}
