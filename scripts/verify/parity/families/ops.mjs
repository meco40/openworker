/**
 * `app/api/ops/**`, `health/**`, `doctor/**`, `internal/**`, `betaclaw/**` and
 * `control-plane/**` parity (14 routes).
 *
 * The TypeScript reference is the route handler itself. Each route module is
 * imported in-process and called with a `NextRequest`, so status and body come
 * from the real code and are not transcribed. The Rust side goes over HTTP.
 *
 * Probe kinds:
 *   - read / guard: run in the default lane only (see below),
 *   - secret: token or signature gates of `internal/*`; they do not depend on
 *     user auth and run in both lanes,
 *   - skip: routes that connect to the BetaClaw runtime or depend on process
 *     state; only their auth probe is kept.
 *
 * Only state-neutral probes run: reads, requests that fail validation or a
 * missing id before any write or runtime call, and secret gates that answer
 * before the body is processed.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides the auth probes and the secret probes run.
 *
 * Module-level singletons of earlier families can keep stale store paths; run
 * this family alone with `--family=ops` if a TS-side error names a path.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { check, checkTrue, rustRequest } from '../harness.mjs';

export const name = 'ops';

const APP_API = '../../../../app/api/';
const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';

const STORE_ROOT = join(tmpdir(), `betaclaw-parity-routes-${process.pid}`);
const STORE_FILES = {
  DATABASE_PATH: 'mission-control.db',
  GATEWAY_CONFIG_DB_PATH: 'gateway-config.db',
  MESSAGES_DB_PATH: 'messages.db',
  MASTER_DB_PATH: 'master.db',
  AUTOMATION_DB_PATH: 'automation.db',
  SKILLS_DB_PATH: 'skills.db',
  STATS_DB_PATH: 'stats.db',
  PERSONAS_DB_PATH: 'personas.db',
  KNOWLEDGE_DB_PATH: 'knowledge.db',
  MEMORY_DB_PATH: 'memory.db',
  CLAWHUB_DB_PATH: 'clawhub.db',
  PROACTIVE_DB_PATH: 'proactive.db',
  MODEL_HUB_DB_PATH: 'model-hub.db',
  AUTH_DB_PATH: 'auth.db',
  SUBAGENT_RUNS_STORE_PATH: 'subagent-runs.json',
  PROJECTS_PATH: 'projects',
  WORKSPACE_BASE_PATH: 'workspaces',
  PERSONAS_ROOT_PATH: 'personas',
  CHAT_ATTACHMENTS_DIR: 'attachments',
  BETACLAW_SKILLS_DIR: 'skills',
  CLAWHUB_WORKDIR: 'clawhub',
};

const MISSING = 'parity-missing';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // ops: read-only instance, node and session views
  {
    kind: 'read',
    label: 'GET /api/ops/instances',
    route: 'ops/instances/route.ts',
    method: 'GET',
    path: '/api/ops/instances',
  },
  {
    kind: 'read',
    label: 'GET /api/ops/nodes',
    route: 'ops/nodes/route.ts',
    method: 'GET',
    path: '/api/ops/nodes',
  },
  {
    kind: 'guard',
    label: 'POST /api/ops/nodes ohne action',
    route: 'ops/nodes/route.ts',
    method: 'POST',
    path: '/api/ops/nodes',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/ops/sessions',
    route: 'ops/sessions/route.ts',
    method: 'GET',
    path: '/api/ops/sessions',
  },

  // health and doctor: local OS and store status, shape compared
  {
    kind: 'read',
    label: 'GET /api/health',
    route: 'health/route.ts',
    method: 'GET',
    path: '/api/health',
  },
  {
    kind: 'skip',
    label: 'GET /api/health/scheduler',
    reason:
      'Status hängt am Scheduler-Lease des Prozesses; Token-Gate nur mit SCHEDULER_HEALTH_TOKEN',
  },
  {
    kind: 'read',
    label: 'GET /api/health/world-model',
    route: 'health/world-model/route.ts',
    method: 'GET',
    path: '/api/health/world-model',
  },
  {
    kind: 'read',
    label: 'GET /api/doctor',
    route: 'doctor/route.ts',
    method: 'GET',
    path: '/api/doctor',
  },

  // internal: token and feature-flag gates answer before the body is read
  {
    kind: 'secret',
    label: 'POST /api/internal/model-hub/graphiti/v1/chat/completions ohne Token',
    route: 'internal/model-hub/graphiti/[...path]/route.ts',
    method: 'POST',
    path: '/api/internal/model-hub/graphiti/v1/chat/completions',
    params: { path: ['v1', 'chat', 'completions'] },
    body: {},
  },
  {
    kind: 'secret',
    label: 'POST /api/internal/stats/engineering/snapshots ohne Token',
    route: 'internal/stats/engineering/snapshots/route.ts',
    method: 'POST',
    path: '/api/internal/stats/engineering/snapshots',
    body: {},
  },

  // control-plane: resolved user context, no 401 gate; the shape is compared
  {
    kind: 'read',
    label: 'GET /api/control-plane/metrics',
    route: 'control-plane/metrics/route.ts',
    method: 'GET',
    path: '/api/control-plane/metrics',
  },

  // betaclaw: models is local; status and sessions connect to the runtime
  {
    kind: 'read',
    label: 'GET /api/betaclaw/models',
    route: 'betaclaw/models/route.ts',
    method: 'GET',
    path: '/api/betaclaw/models',
  },
  {
    kind: 'skip',
    label: 'GET /api/betaclaw/status',
    reason: 'verbindet sich mit der BetaClaw-Runtime; nur Auth-Probe',
  },
  {
    kind: 'skip',
    label: 'GET /api/betaclaw/sessions',
    reason: 'verbindet sich mit der BetaClaw-Runtime; nur Auth-Probe',
  },
  {
    kind: 'guard',
    label: 'POST /api/betaclaw/sessions ohne channel',
    route: 'betaclaw/sessions/route.ts',
    method: 'POST',
    path: '/api/betaclaw/sessions',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/betaclaw/sessions/[id] (fehlend)',
    route: 'betaclaw/sessions/[id]/route.ts',
    method: 'GET',
    path: `/api/betaclaw/sessions/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/betaclaw/sessions/[id] (fehlend)',
    route: 'betaclaw/sessions/[id]/route.ts',
    method: 'POST',
    path: `/api/betaclaw/sessions/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/betaclaw/sessions/[id] (fehlend)',
    route: 'betaclaw/sessions/[id]/route.ts',
    method: 'PATCH',
    path: `/api/betaclaw/sessions/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/betaclaw/sessions/[id] (fehlend)',
    route: 'betaclaw/sessions/[id]/route.ts',
    method: 'DELETE',
    path: `/api/betaclaw/sessions/${MISSING}`,
    params: { id: MISSING },
  },
];

/**
 * One anonymous request per route file. Checked only in the auth lane.
 * `gate` marks routes without a 401 gate: they are reported, not compared.
 */
const AUTH_CASES = [
  { label: 'ops/instances', method: 'GET', path: '/api/ops/instances' },
  { label: 'ops/nodes', method: 'GET', path: '/api/ops/nodes' },
  { label: 'ops/sessions', method: 'GET', path: '/api/ops/sessions' },
  { label: 'health', method: 'GET', path: '/api/health' },
  {
    label: 'health/scheduler',
    gate: 'token',
    note: 'Token-Gate über SCHEDULER_HEALTH_TOKEN, kein User-Auth',
  },
  { label: 'health/world-model', gate: 'public', note: 'ohne Auth-Gate (öffentlich)' },
  { label: 'doctor', method: 'GET', path: '/api/doctor' },
  {
    label: 'internal/model-hub/graphiti',
    gate: 'secret',
    note: 'Bearer-Token über den Secret-Probe geprüft',
  },
  {
    label: 'internal/stats/engineering/snapshots',
    gate: 'secret',
    note: 'Ingest-Token über den Secret-Probe geprüft',
  },
  {
    label: 'control-plane/metrics',
    gate: 'resolved',
    note: 'withResolvedUserContext: kein 401; Befund, siehe Bericht',
  },
  { label: 'betaclaw/models', method: 'GET', path: '/api/betaclaw/models' },
  { label: 'betaclaw/status', method: 'GET', path: '/api/betaclaw/status' },
  { label: 'betaclaw/sessions', method: 'GET', path: '/api/betaclaw/sessions' },
  { label: 'betaclaw/sessions (POST)', method: 'POST', path: '/api/betaclaw/sessions' },
  { label: 'betaclaw/sessions/[id]', method: 'GET', path: `/api/betaclaw/sessions/${MISSING}` },
];

function isolateStores() {
  mkdirSync(STORE_ROOT, { recursive: true });
  for (const [key, file] of Object.entries(STORE_FILES)) {
    process.env[key] = join(STORE_ROOT, file);
  }
}

const routeModules = new Map();
function loadRoute(route) {
  if (!routeModules.has(route)) {
    routeModules.set(route, import(`${APP_API}${route}`));
  }
  return routeModules.get(route);
}

/** Reads a TS response. SSE bodies are never drained: headers are kept, the stream is cancelled. */
async function readTsResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    await response.body?.cancel();
    return { status: response.status, contentType, json: null, text: '' };
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body stays raw; the comparison then sees null on both sides
  }
  return { status: response.status, contentType, json, text };
}

/** Calls the real route handler in-process. */
async function tsCall(route, method, path, { params, body } = {}) {
  const mod = await loadRoute(route);
  const handler = mod[method];
  if (typeof handler !== 'function') {
    throw new Error(`${route} exportiert kein ${method}`);
  }
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const request = new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers,
    body: payload,
  });
  const response =
    params === undefined
      ? await handler(request)
      : await handler(request, { params: Promise.resolve(params) });
  return readTsResponse(response);
}

/** Returns the paths where the two JSON values differ in keys or value types. */
function shapeMismatches(rust, ts, path = '$') {
  const rustKind = kindOf(rust);
  const tsKind = kindOf(ts);
  if (rustKind !== tsKind) {
    if (
      (rustKind === 'number' && tsKind === 'null') ||
      (rustKind === 'null' && tsKind === 'number')
    ) {
      return [];
    }
    return [`${path}: ${rustKind} != ${tsKind}`];
  }
  if (rustKind === 'array') {
    // Lists are compared by element shape only when both sides have elements.
    if (rust.length === 0 || ts.length === 0) return [];
    return shapeMismatches(rust[0], ts[0], `${path}[]`);
  }
  if (rustKind === 'object') {
    const mismatches = [];
    for (const key of new Set([...Object.keys(rust), ...Object.keys(ts)])) {
      if (!(key in rust)) mismatches.push(`${path}.${key}: fehlt in Rust`);
      else if (!(key in ts)) mismatches.push(`${path}.${key}: fehlt in TS`);
      else mismatches.push(...shapeMismatches(rust[key], ts[key], `${path}.${key}`));
    }
    return mismatches;
  }
  return [];
}

function kindOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function compareJson(label, rust, ts) {
  check(`${label}: Status`, rust.status, ts.status);
  if (ts.status >= 400 && ts.status < 500) {
    check(`${label}: error`, rust.json?.error, ts.json?.error);
  }
  const mismatches = shapeMismatches(rust.json, ts.json);
  checkTrue(
    `${label}: Body-Form (Schlüssel und Typen)`,
    mismatches.length === 0,
    mismatches.join(' | '),
  );
}

async function runJsonCase(c) {
  const rust = await rustRequest(c.method, c.path, { body: c.body });
  const ts = await tsCall(c.route, c.method, c.path, { params: c.params, body: c.body });
  compareJson(c.label, rust, ts);
}

async function runCase(c) {
  try {
    return await runJsonCase(c);
  } catch (error) {
    checkTrue(c.label, false, error instanceof Error ? error.message : String(error));
  }
}

async function runAuthCase(c) {
  try {
    const rust = await rustRequest(c.method, c.path);
    check(`${c.label} (anonym): Status`, rust.status, 401);
    checkTrue(
      `${c.label} (anonym): error = Unauthorized`,
      rust.json?.error === 'Unauthorized',
      JSON.stringify(rust.json ?? rust.text).slice(0, 200),
    );
  } catch (error) {
    checkTrue(`${c.label} (anonym)`, false, error instanceof Error ? error.message : String(error));
  }
}

export async function run() {
  isolateStores();

  if (AUTH_LANE) {
    console.log('--- Auth-Lauf (REQUIRE_AUTH=true) ---');
    // Without a session, resolveUserIdFromSession answers null; withUserContext and the
    // manual checks turn that into 401 `{ ok: false, error: 'Unauthorized' }`.
    const { resolveUserIdFromSession } = await import('../../../../src/server/auth/userContext.ts');
    checkTrue(
      'TS-Referenz: ohne Session liefert die Auth-Auflösung null',
      resolveUserIdFromSession(null, true) === null,
    );
    for (const c of AUTH_CASES) {
      if (c.gate) {
        console.log(`SKIP ${c.label} (anonym) — ${c.note}`);
        continue;
      }
      await runAuthCase(c);
    }
    // Secret gates are independent of REQUIRE_AUTH and run in this lane too.
    for (const c of CASES.filter((item) => item.kind === 'secret')) {
      await runCase(c);
    }
    return;
  }

  console.log('--- Standardlauf (REQUIRE_AUTH nicht gesetzt) ---');
  for (const c of CASES) {
    if (c.kind === 'skip') {
      console.log(`SKIP ${c.label} — ${c.reason}`);
      continue;
    }
    await runCase(c);
  }
  console.log(
    `SKIP Auth-Fall für ${AUTH_CASES.filter((c) => !c.gate).length} Routen — nur im Auth-Lauf (REQUIRE_AUTH=true auf Gateway und Harness)`,
  );
  for (const c of AUTH_CASES.filter((item) => item.gate)) {
    console.log(`SKIP ${c.label} (anonym) — ${c.note}`);
  }
}
