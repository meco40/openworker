/**
 * `/api/tasks/**`, `workspaces`, `agents` and `automations` parity (24 routes).
 *
 * The reference is `golden/tasks.json`, recorded from the TypeScript route handlers
 * before their removal. The Rust side goes over HTTP.
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
 */
import { check, checkTrue, goldenReference, rustRequest } from '../harness.mjs';

export const name = 'tasks';

const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
// Auth-lane reference values differ from the default lane (e.g. REQUIRE_AUTH gates first), so they get their own keys.
const caseKey = (label) => (AUTH_LANE ? `auth lane: ${label}` : label);

const MISSING = 'parity-missing';

/** Route probes. Dynamic params are passed as a Promise, like Next does. */
const CASES = [
  // tasks: list and create (create fails validation on an empty body)
  {
    kind: 'read',
    label: 'GET /api/tasks',
    method: 'GET',
    path: '/api/tasks',
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks ohne title',
    method: 'POST',
    path: '/api/tasks',
    body: {},
  },

  // tasks/[id]: every handler checks task access first, so a missing id stops before any write
  {
    kind: 'read',
    label: 'GET /api/tasks/[id] (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/tasks/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/tasks/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/tasks/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/activities (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/activities`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/activities (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/activities`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/deliverables (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/deliverables`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/deliverables (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/deliverables`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/dispatch (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/dispatch`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/planning (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/tasks/[id]/planning (fehlend)',
    method: 'DELETE',
    path: `/api/tasks/${MISSING}/planning`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning/answer (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/answer`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/planning/poll (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/planning/poll`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/planning/retry-dispatch (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/planning/retry-dispatch`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/subagent (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/subagent`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/subagent (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/subagent`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/tasks/[id]/test (fehlend)',
    method: 'GET',
    path: `/api/tasks/${MISSING}/test`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/tasks/[id]/test (fehlend)',
    method: 'POST',
    path: `/api/tasks/${MISSING}/test`,
    params: { id: MISSING },
  },

  // workspaces: the default workspace is refused before any lookup
  {
    kind: 'read',
    label: 'GET /api/workspaces',
    method: 'GET',
    path: '/api/workspaces',
  },
  {
    kind: 'guard',
    label: 'POST /api/workspaces ohne name',
    method: 'POST',
    path: '/api/workspaces',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/workspaces/[id] (fehlend)',
    method: 'GET',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/workspaces/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/workspaces/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/workspaces/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/workspaces/default',
    method: 'DELETE',
    path: '/api/workspaces/default',
    params: { id: 'default' },
  },

  // agents
  {
    kind: 'read',
    label: 'GET /api/agents',
    method: 'GET',
    path: '/api/agents',
  },
  {
    kind: 'guard',
    label: 'POST /api/agents ohne name/role',
    method: 'POST',
    path: '/api/agents',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/agents/[id] (fehlend)',
    method: 'GET',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/agents/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/agents/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/agents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/agents/[id]/betaclaw (fehlend)',
    method: 'GET',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/agents/[id]/betaclaw (fehlend)',
    method: 'POST',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'DELETE /api/agents/[id]/betaclaw (fehlend)',
    method: 'DELETE',
    path: `/api/agents/${MISSING}/betaclaw`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'GET /api/agents/discover (unbekannter Workspace)',
    method: 'GET',
    path: `/api/agents/discover?workspace_id=${MISSING}`,
  },
  {
    kind: 'guard',
    label: 'POST /api/agents/import ohne agents',
    method: 'POST',
    path: '/api/agents/import',
    body: {},
  },

  // automations
  {
    kind: 'read',
    label: 'GET /api/automations',
    method: 'GET',
    path: '/api/automations',
  },
  {
    kind: 'guard',
    label: 'POST /api/automations ohne Pflichtfelder',
    method: 'POST',
    path: '/api/automations',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/automations/[id] (fehlend)',
    method: 'GET',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/automations/[id] (fehlend)',
    method: 'PATCH',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/automations/[id] (fehlend)',
    method: 'DELETE',
    path: `/api/automations/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/automations/[id]/flow (fehlend)',
    method: 'GET',
    path: `/api/automations/${MISSING}/flow`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PUT /api/automations/[id]/flow ohne flowGraph',
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
    method: 'GET',
    path: `/api/automations/${MISSING}/runs`,
    params: { id: MISSING },
  },
  {
    kind: 'read',
    label: 'GET /api/automations/metrics',
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
  const ts = await goldenReference(name, caseKey(c.label));
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
  if (AUTH_LANE) {
    console.log('--- Auth-Lauf (REQUIRE_AUTH=true) ---');
    // Without a session, resolveUserIdFromSession answers null; withUserContext and the
    // manual checks turn that into 401 `{ ok: false, error: 'Unauthorized' }`.
    const authNull = await goldenReference(name, 'resolveUserIdFromSession(null, true)');
    checkTrue('TS-Referenz: ohne Session liefert die Auth-Auflösung null', authNull === null);
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
