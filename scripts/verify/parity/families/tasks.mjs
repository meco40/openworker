/**
 * `app/api/tasks/**`, `workspaces`, `agents` and `automations` parity (24 routes).
 *
 * The TypeScript reference is the route handler itself. Each route module is
 * imported in-process and called with a `NextRequest`, so status and body come
 * from the real code and are not transcribed. The Rust side goes over HTTP.
 *
 * Only state-neutral probes run:
 *   - reads of empty lists and of missing ids,
 *   - requests that fail validation, or fail the task/workspace/agent access
 *     check, before any write or runtime call, and
 *   - anonymous requests in the auth lane.
 * Routes that start agents, planning or automation runs (`tasks/[id]/dispatch`
 * success path, `tasks/[id]/planning/answer`, `automations/[id]/run`) are only
 * probed for auth or for the access check, never for their success path.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides only the auth probes run, because every
 * other probe is answered with 401 there.
 *
 * All stores are redirected to a per-process temp directory (`DATABASE_PATH`
 * for `src/lib/db`, plus the `*_DB_PATH` variables of the services). Module-
 * level singletons of earlier families can keep stale store paths; run this
 * family alone with `--family=tasks` if a TS-side error names a DB path.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { check, checkTrue, rustRequest } from '../harness.mjs';

export const name = 'tasks';

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
  // tasks: list and create (create fails validation on an empty body)
  {
    kind: 'read',
    label: 'GET /api/tasks',
    route: 'tasks/route.ts',
    method: 'GET',
    path: '/api/tasks',
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks ohne title',
    route: 'tasks/route.ts',
    method: 'POST',
    path: '/api/tasks',
    body: {},
  },

  // tasks/[id]: every handler checks task access first, so a missing id stops before any write
  {
    kind: 'read',
    label: 'GET /api/tasks/[id] (fehlend)',
    route: 'tasks/[id]/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/tasks/[id] (fehlend)',
    route: 'tasks/[id]/route.ts',
    method: 'PATCH',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/tasks/[id] (fehlend)',
    route: 'tasks/[id]/route.ts',
    method: 'DELETE',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/activities (fehlend)',
    route: 'tasks/[id]/activities/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/activities`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/activities (fehlend)',
    route: 'tasks/[id]/activities/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/activities`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/deliverables (fehlend)',
    route: 'tasks/[id]/deliverables/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/deliverables`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/deliverables (fehlend)',
    route: 'tasks/[id]/deliverables/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/deliverables`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/dispatch (fehlend)',
    route: 'tasks/[id]/dispatch/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/dispatch`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/planning (fehlend)',
    route: 'tasks/[id]/planning/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning (fehlend)',
    route: 'tasks/[id]/planning/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/tasks/[id]/planning (fehlend)',
    route: 'tasks/[id]/planning/route.ts',
    method: 'DELETE',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning/answer (fehlend)',
    route: 'tasks/[id]/planning/answer/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/answer`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/planning/poll (fehlend)',
    route: 'tasks/[id]/planning/poll/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/planning/poll`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning/retry-dispatch (fehlend)',
    route: 'tasks/[id]/planning/retry-dispatch/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/retry-dispatch`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/subagent (fehlend)',
    route: 'tasks/[id]/subagent/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/subagent`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/subagent (fehlend)',
    route: 'tasks/[id]/subagent/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/subagent`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/test (fehlend)',
    route: 'tasks/[id]/test/route.ts',
    method: 'GET',
    path: `/api/tasks/${MISSING}/test`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/test (fehlend)',
    route: 'tasks/[id]/test/route.ts',
    method: 'POST',
    path: `/api/tasks/${MISSING}/test`,
    params: { id: MISSING },
  },

  // workspaces: the default workspace is refused before any lookup
  {
    kind: 'read',
    label: 'GET /api/workspaces',
    route: 'workspaces/route.ts',
    method: 'GET',
    path: '/api/workspaces',
  },
  {
    kind: 'guard',
    label: 'POST /api/workspaces ohne name',
    route: 'workspaces/route.ts',
    method: 'POST',
    path: '/api/workspaces',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/workspaces/[id] (fehlend)',
    route: 'workspaces/[id]/route.ts',
    method: 'GET',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/workspaces/[id] (fehlend)',
    route: 'workspaces/[id]/route.ts',
    method: 'PATCH',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/workspaces/[id] (fehlend)',
    route: 'workspaces/[id]/route.ts',
    method: 'DELETE',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/workspaces/default',
    route: 'workspaces/[id]/route.ts',
    method: 'DELETE',
    path: '/api/workspaces/default',
    params: { id: 'default' },
  },

  // agents
  {
    kind: 'read',
    label: 'GET /api/agents',
    route: 'agents/route.ts',
    method: 'GET',
    path: '/api/agents',
  },
  {
    kind: 'guard',
    label: 'POST /api/agents ohne name/role',
    route: 'agents/route.ts',
    method: 'POST',
    path: '/api/agents',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/agents/[id] (fehlend)',
    route: 'agents/[id]/route.ts',
    method: 'GET',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/agents/[id] (fehlend)',
    route: 'agents/[id]/route.ts',
    method: 'PATCH',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/agents/[id] (fehlend)',
    route: 'agents/[id]/route.ts',
    method: 'DELETE',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/agents/[id]/betaclaw (fehlend)',
    route: 'agents/[id]/betaclaw/route.ts',
    method: 'GET',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/agents/[id]/betaclaw (fehlend)',
    route: 'agents/[id]/betaclaw/route.ts',
    method: 'POST',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/agents/[id]/betaclaw (fehlend)',
    route: 'agents/[id]/betaclaw/route.ts',
    method: 'DELETE',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'GET /api/agents/discover (unbekannter Workspace)',
    route: 'agents/discover/route.ts',
    method: 'GET',
    path: `/api/agents/discover?workspace_id=${MISSING}`,
  },
  {
    kind: 'guard',
    label: 'POST /api/agents/import ohne agents',
    route: 'agents/import/route.ts',
    method: 'POST',
    path: '/api/agents/import',
    body: {},
  },

  // automations
  {
    kind: 'read',
    label: 'GET /api/automations',
    route: 'automations/route.ts',
    method: 'GET',
    path: '/api/automations',
  },
  {
    kind: 'guard',
    label: 'POST /api/automations ohne Pflichtfelder',
    route: 'automations/route.ts',
    method: 'POST',
    path: '/api/automations',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/automations/[id] (fehlend)',
    route: 'automations/[id]/route.ts',
    method: 'GET',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/automations/[id] (fehlend)',
    route: 'automations/[id]/route.ts',
    method: 'PATCH',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/automations/[id] (fehlend)',
    route: 'automations/[id]/route.ts',
    method: 'DELETE',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/automations/[id]/flow (fehlend)',
    route: 'automations/[id]/flow/route.ts',
    method: 'GET',
    path: `/api/automations/${MISSING}/flow`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PUT /api/automations/[id]/flow ohne flowGraph',
    route: 'automations/[id]/flow/route.ts',
    method: 'PUT',
    path: `/api/automations/${MISSING}/flow`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'skip',
    label: 'POST /api/automations/[id]/run',
    reason: 'startet einen Lauf (Agent-Aufruf); nur Auth-Probe',
  },
  {
    kind: 'read',
    label: 'GET /api/automations/[id]/runs (fehlend)',
    route: 'automations/[id]/runs/route.ts',
    method: 'GET',
    path: `/api/automations/${MISSING}/runs`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/automations/metrics',
    route: 'automations/metrics/route.ts',
    method: 'GET',
    path: '/api/automations/metrics',
  },
];

/** One anonymous request per route file. Checked only in the auth lane. */
const AUTH_CASES = [
  { label: 'tasks', method: 'GET', path: '/api/tasks' },
  { label: 'tasks/[id]', method: 'GET', path: `/api/tasks/${MISSING}` },
  { label: 'tasks/[id]/activities', method: 'GET', path: `/api/tasks/${MISSING}/activities` },
  { label: 'tasks/[id]/deliverables', method: 'GET', path: `/api/tasks/${MISSING}/deliverables` },
  { label: 'tasks/[id]/dispatch', method: 'POST', path: `/api/tasks/${MISSING}/dispatch` },
  { label: 'tasks/[id]/planning', method: 'GET', path: `/api/tasks/${MISSING}/planning` },
  {
    label: 'tasks/[id]/planning/answer',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/answer`,
  },
  { label: 'tasks/[id]/planning/poll', method: 'GET', path: `/api/tasks/${MISSING}/planning/poll` },
  {
    label: 'tasks/[id]/planning/retry-dispatch',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/retry-dispatch`,
  },
  { label: 'tasks/[id]/subagent', method: 'GET', path: `/api/tasks/${MISSING}/subagent` },
  { label: 'tasks/[id]/test', method: 'GET', path: `/api/tasks/${MISSING}/test` },
  { label: 'workspaces', method: 'GET', path: '/api/workspaces' },
  { label: 'workspaces/[id]', method: 'GET', path: `/api/workspaces/${MISSING}` },
  { label: 'agents', method: 'GET', path: '/api/agents' },
  { label: 'agents/[id]', method: 'GET', path: `/api/agents/${MISSING}` },
  { label: 'agents/[id]/betaclaw', method: 'GET', path: `/api/agents/${MISSING}/betaclaw` },
  { label: 'agents/discover', method: 'GET', path: '/api/agents/discover' },
  { label: 'agents/import', method: 'POST', path: '/api/agents/import' },
  { label: 'automations', method: 'GET', path: '/api/automations' },
  { label: 'automations/[id]', method: 'GET', path: `/api/automations/${MISSING}` },
  { label: 'automations/[id]/flow', method: 'GET', path: `/api/automations/${MISSING}/flow` },
  { label: 'automations/[id]/run', method: 'POST', path: `/api/automations/${MISSING}/run` },
  { label: 'automations/[id]/runs', method: 'GET', path: `/api/automations/${MISSING}/runs` },
  { label: 'automations/metrics', method: 'GET', path: '/api/automations/metrics' },
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
      await runAuthCase(c);
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
    `SKIP Auth-Fall für ${AUTH_CASES.length} Routen — nur im Auth-Lauf (REQUIRE_AUTH=true auf Gateway und Harness)`,
  );
}
