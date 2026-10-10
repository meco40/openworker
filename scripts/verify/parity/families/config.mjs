/**
 * `/api/config` parity: load with redaction, revision-guarded save, secret
 * restore on round-trip, persistence, stale-revision conflict and validation
 * errors.
 *
 * The TypeScript side drives `loadGatewayConfig`/`saveGatewayConfig`
 * in-process and applies the same response mapping as
 * `app/api/config/route.ts`; the Rust side goes over HTTP. Both sides must
 * start from the default config: the documented container flow creates a fresh
 * container per run, CI points `GATEWAY_CONFIG_DB_PATH` at a fresh file.
 *
 * The flow is state-neutral: the mutated config from step 2 is restored in
 * step 4, so the family can also run against a long-lived gateway.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkTrue, rustRequest, bestEffortRemoveDir } from '../harness.mjs';

export const name = 'config';

let configModule = null;
async function tsConfig() {
  if (!configModule) {
    configModule = await import('../../../../src/server/config/gateway/gatewayConfig.ts');
  }
  return configModule;
}

/** The response mapping of `app/api/config/route.ts` around a successful load. */
async function typescriptGet() {
  const { loadGatewayConfig, redactGatewayConfigSecrets, toGatewayConfigDisplayPath } =
    await tsConfig();
  const loaded = await loadGatewayConfig();
  return {
    status: 200,
    body: {
      ok: true,
      config: redactGatewayConfigSecrets(loaded.config),
      source: loaded.source,
      displayPath: toGatewayConfigDisplayPath(loaded.path),
      warnings: loaded.warnings,
      revision: loaded.revision,
    },
  };
}

/** The response mapping of `app/api/config/route.ts` around `saveGatewayConfig`. */
async function typescriptPut(config, revision, { raw } = {}) {
  const {
    saveGatewayConfig,
    redactGatewayConfigSecrets,
    toGatewayConfigDisplayPath,
    GatewayConfigConflictError,
    GatewayConfigValidationError,
  } = await tsConfig();

  if (raw !== undefined) {
    // `request.json()` throws on a non-JSON body; the route answers 400.
    return {
      status: 400,
      body: {
        ok: false,
        error: 'Invalid JSON body. Expected object.',
        code: 'CONFIG_VALIDATION_ERROR',
      },
    };
  }
  if (config === undefined) {
    // hasOwnProperty('config') check in the route, before any save call.
    return {
      status: 400,
      body: { ok: false, error: 'config is required.', code: 'CONFIG_VALIDATION_ERROR' },
    };
  }
  if (!String(revision ?? '').trim()) {
    // The route answers 409 without `currentRevision` when no revision was sent.
    return {
      status: 409,
      body: {
        ok: false,
        error: 'config.revision is required to prevent stale writes.',
        code: 'CONFIG_STALE_REVISION',
      },
    };
  }

  try {
    const saved = await saveGatewayConfig(config, { expectedRevision: revision });
    return {
      status: 200,
      body: {
        ok: true,
        config: redactGatewayConfigSecrets(saved.config),
        source: saved.source,
        displayPath: toGatewayConfigDisplayPath(saved.path),
        warnings: saved.warnings,
        revision: saved.revision,
      },
    };
  } catch (error) {
    if (error instanceof GatewayConfigConflictError) {
      return {
        status: 409,
        body: {
          ok: false,
          error: 'Config was changed by another session. Reload and review your changes.',
          code: 'CONFIG_STALE_REVISION',
          currentRevision: error.currentRevision,
        },
      };
    }
    if (error instanceof GatewayConfigValidationError) {
      return {
        status: 400,
        body: { ok: false, error: error.message, code: 'CONFIG_VALIDATION_ERROR' },
      };
    }
    throw error;
  }
}

function rustGet() {
  return rustRequest('GET', '/api/config');
}

async function rustPut(config, revision, { raw } = {}) {
  if (raw !== undefined) {
    return rustRequest('PUT', '/api/config', { raw });
  }
  const body = revision === undefined ? { config } : { config, revision };
  return rustRequest('PUT', '/api/config', { body });
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
  // The TypeScript side resolves its config database from the environment at
  // call time, so the temp path can be set right before the flow starts.
  const dir = mkdtempSync(join(tmpdir(), 'betaclaw-parity-config-'));
  process.env.GATEWAY_CONFIG_DB_PATH = join(dir, 'gateway-config.db');
  process.env.BETACLAW_CONFIG_BACKEND = 'db';

  try {
    console.log('--- GET (Default) ---');
    const initialTs = await typescriptGet();
    const initialRust = await rustGet();
    compareLoad('GET', initialRust, initialTs);

    const mutated = mutate(initialTs.body.config);
    const mutatedRust = mutate(initialRust.body.config);

    console.log('\n--- PUT (mutiert, mit Revision) ---');
    const savedTs = await typescriptPut(mutated, initialTs.body.revision);
    const savedRust = await rustPut(mutatedRust, initialRust.body.revision);
    check('PUT status', savedRust.status, savedTs.status);
    check('PUT config', savedRust.body?.config, savedTs.body?.config);
    check('PUT revision', savedRust.body?.revision, savedTs.body?.revision);

    console.log('\n--- GET (Persistenz der Mutation) ---');
    const persistedTs = await typescriptGet();
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
    const restoredTs = await typescriptPut(initialTs.body.config, savedTs.body.revision);
    const restoredRust = await rustPut(initialRust.body.config, savedRust.body.revision);
    check('Restore status', restoredRust.status, restoredTs.status);
    check('Restore revision', restoredRust.body?.revision, restoredTs.body?.revision);

    console.log('\n--- PUT (veraltete Revision) ---');
    const staleTs = await typescriptPut(mutated, 'stale-parity-revision');
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
    const noRevisionTs = await typescriptPut(mutated, '');
    const noRevisionRust = await rustPut(mutatedRust);
    check('Fehlende Revision status', noRevisionRust.status, noRevisionTs.status);
    check('Fehlende Revision code', noRevisionRust.body?.code, noRevisionTs.body?.code);

    console.log('\n--- PUT (config-Feld fehlt) ---');
    const noConfigTs = await typescriptPut(undefined, 'irrelevant');
    const noConfigRust = await rustPut(undefined, 'irrelevant');
    check('Config fehlt status', noConfigRust.status, noConfigTs.status);
    check('Config fehlt code', noConfigRust.body?.code, noConfigTs.body?.code);

    console.log('\n--- PUT (ungültiges JSON) ---');
    const invalidTs = await typescriptPut(undefined, undefined, { raw: '{invalid' });
    const invalidRust = await rustPut(undefined, undefined, { raw: '{invalid' });
    check('Ungültiges JSON status', invalidRust.status, invalidTs.status);
    check('Ungültiges JSON code', invalidRust.body?.code, invalidTs.body?.code);
  } finally {
    bestEffortRemoveDir(dir);
  }
}
