/**
 * `app/api/master/**` parity (18 routes: approvals, events, gmail, metrics,
 * notes, reminders, runs, settings, subagents, voice-session).
 *
 * The TypeScript reference is the route handler itself. Each route module is
 * imported in-process and called with a `NextRequest`, so status and body come
 * from the real code and are not transcribed. The Rust side goes over HTTP.
 *
 * Only state-neutral probes run:
 *   - reads of empty lists and of missing ids,
 *   - requests that fail validation before any write (empty body, invalid
 *     fields), and
 *   - anonymous requests in the auth lane.
 * `voice-session` calls xAI and is only probed for auth. Success paths that
 * write data are not run here and are listed as SKIP.
 *
 * Lanes: by default (`REQUIRE_AUTH` unset on the gateway and in this process)
 * the main probes run and the anonymous auth probes are reported as SKIP. With
 * `REQUIRE_AUTH=true` on both sides only the auth probes run, because every
 * other probe is answered with 401 there.
 *
 * Module-level singletons of earlier families can keep stale store paths; run
 * this family alone with `--family=master` if a TS-side error names a DB path.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { check, checkTrue, rustRequest } from '../harness.mjs';

export const name = 'master';

const APP_API = '../../../../app/api/';
const AUTH_LANE = process.env.REQUIRE_AUTH === 'true';
const RUST_ORIGIN = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:3000';
const CONTAINER = process.env.GATEWAY_CONTAINER || 'betaclaw-gateway-ws';

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

/** Routes whose TS handler is invoked in-process. Dynamic params as Promise, like Next. */
const CASES = [
  // approvals (feature flag on by default)
  {
    kind: 'read',
    label: 'GET /api/master/approvals',
    route: 'master/approvals/route.ts',
    method: 'GET',
    path: '/api/master/approvals',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/approvals/[id]/decision ohne decision',
    route: 'master/approvals/[id]/decision/route.ts',
    method: 'POST',
    path: `/api/master/approvals/${MISSING}/decision`,
    params: { id: MISSING },
    body: {},
  },

  // events: SSE stream while the operator-events flag is on (default)
  {
    kind: 'head',
    label: 'GET /api/master/events (SSE)',
    route: 'master/events/route.ts',
    method: 'GET',
    path: '/api/master/events?workspaceId=default',
  },

  // gmail: validation fails before any connector call
  {
    kind: 'guard',
    label: 'POST /api/master/gmail ohne action',
    route: 'master/gmail/route.ts',
    method: 'POST',
    path: '/api/master/gmail',
    body: {},
  },

  {
    kind: 'read',
    label: 'GET /api/master/metrics',
    route: 'master/metrics/route.ts',
    method: 'GET',
    path: '/api/master/metrics',
  },

  // notes
  {
    kind: 'read',
    label: 'GET /api/master/notes',
    route: 'master/notes/route.ts',
    method: 'GET',
    path: '/api/master/notes',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/notes ohne title/content',
    route: 'master/notes/route.ts',
    method: 'POST',
    path: '/api/master/notes',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/notes ohne noteId',
    route: 'master/notes/route.ts',
    method: 'PATCH',
    path: '/api/master/notes',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/notes ohne noteId',
    route: 'master/notes/route.ts',
    method: 'DELETE',
    path: '/api/master/notes',
    body: {},
  },

  // reminders
  {
    kind: 'read',
    label: 'GET /api/master/reminders',
    route: 'master/reminders/route.ts',
    method: 'GET',
    path: '/api/master/reminders',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/reminders ohne Pflichtfelder',
    route: 'master/reminders/route.ts',
    method: 'POST',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/reminders ohne reminderId',
    route: 'master/reminders/route.ts',
    method: 'PATCH',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/reminders ohne reminderId',
    route: 'master/reminders/route.ts',
    method: 'DELETE',
    path: '/api/master/reminders',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/reminders/[id] (fehlend)',
    route: 'master/reminders/[id]/route.ts',
    method: 'GET',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/reminders/[id] (fehlend)',
    route: 'master/reminders/[id]/route.ts',
    method: 'PATCH',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'DELETE /api/master/reminders/[id] (fehlend)',
    route: 'master/reminders/[id]/route.ts',
    method: 'DELETE',
    path: `/api/master/reminders/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/master/reminders/[id]/fire (fehlend)',
    route: 'master/reminders/[id]/fire/route.ts',
    method: 'POST',
    path: `/api/master/reminders/${MISSING}/fire`,
    params: { id: MISSING },
    body: {},
  },

  // runs
  {
    kind: 'read',
    label: 'GET /api/master/runs',
    route: 'master/runs/route.ts',
    method: 'GET',
    path: '/api/master/runs',
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs ohne title/contract',
    route: 'master/runs/route.ts',
    method: 'POST',
    path: '/api/master/runs',
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/runs/[id] (fehlend)',
    route: 'master/runs/[id]/route.ts',
    method: 'GET',
    path: `/api/master/runs/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/runs/[id] (fehlend)',
    route: 'master/runs/[id]/route.ts',
    method: 'PATCH',
    path: `/api/master/runs/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/actions ohne actionType',
    route: 'master/runs/[id]/actions/route.ts',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/actions`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'read',
    label: 'GET /api/master/runs/[id]/delegations (fehlend)',
    route: 'master/runs/[id]/delegations/route.ts',
    method: 'GET',
    path: `/api/master/runs/${MISSING}/delegations`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/delegations ohne capability',
    route: 'master/runs/[id]/delegations/route.ts',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/delegations`,
    params: { id: MISSING },
    body: {},
  },
  {
    kind: 'guard',
    label: 'POST /api/master/runs/[id]/feedback ohne rating',
    route: 'master/runs/[id]/feedback/route.ts',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/feedback`,
    params: { id: MISSING },
    body: {},
  },

  // settings: GET ensures the system persona (idempotent); PUT fails validation
  {
    kind: 'read',
    label: 'GET /api/master/settings',
    route: 'master/settings/route.ts',
    method: 'GET',
    path: '/api/master/settings',
  },
  {
    kind: 'guard',
    label: 'PUT /api/master/settings mit ungültigem maxToolCalls',
    route: 'master/settings/route.ts',
    method: 'PUT',
    path: '/api/master/settings',
    body: { maxToolCalls: 1 },
  },

  // subagents
  {
    kind: 'read',
    label: 'GET /api/master/subagents',
    route: 'master/subagents/route.ts',
    method: 'GET',
    path: '/api/master/subagents',
  },
  {
    kind: 'read',
    label: 'GET /api/master/subagents/[id] (fehlend)',
    route: 'master/subagents/[id]/route.ts',
    method: 'GET',
    path: `/api/master/subagents/${MISSING}`,
    params: { id: MISSING },
  },
  {
    kind: 'guard',
    label: 'PATCH /api/master/subagents/[id] ohne action',
    route: 'master/subagents/[id]/route.ts',
    method: 'PATCH',
    path: `/api/master/subagents/${MISSING}`,
    params: { id: MISSING },
    body: {},
  },

  // voice-session: calls xAI on success, so only the auth probe runs (below)
  {
    kind: 'skip',
    label: 'GET /api/master/voice-session',
    reason: 'ruft xAI (Realtime-Token) auf; nur Auth-Probe',
  },
];

/** One anonymous request per route file. Checked only in the auth lane. */
const AUTH_CASES = [
  { label: 'master/approvals', method: 'GET', path: '/api/master/approvals' },
  {
    label: 'master/approvals/[id]/decision',
    method: 'POST',
    path: `/api/master/approvals/${MISSING}/decision`,
  },
  { label: 'master/events', method: 'GET', path: '/api/master/events' },
  { label: 'master/gmail', method: 'POST', path: '/api/master/gmail' },
  { label: 'master/metrics', method: 'GET', path: '/api/master/metrics' },
  { label: 'master/notes', method: 'GET', path: '/api/master/notes' },
  { label: 'master/reminders', method: 'GET', path: '/api/master/reminders' },
  { label: 'master/reminders/[id]', method: 'GET', path: `/api/master/reminders/${MISSING}` },
  {
    label: 'master/reminders/[id]/fire',
    method: 'POST',
    path: `/api/master/reminders/${MISSING}/fire`,
  },
  { label: 'master/runs', method: 'GET', path: '/api/master/runs' },
  { label: 'master/runs/[id]', method: 'GET', path: `/api/master/runs/${MISSING}` },
  {
    label: 'master/runs/[id]/actions',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/actions`,
  },
  {
    label: 'master/runs/[id]/delegations',
    method: 'GET',
    path: `/api/master/runs/${MISSING}/delegations`,
  },
  {
    label: 'master/runs/[id]/feedback',
    method: 'POST',
    path: `/api/master/runs/${MISSING}/feedback`,
  },
  { label: 'master/settings', method: 'GET', path: '/api/master/settings' },
  { label: 'master/subagents', method: 'GET', path: '/api/master/subagents' },
  { label: 'master/subagents/[id]', method: 'GET', path: `/api/master/subagents/${MISSING}` },
  { label: 'master/voice-session', method: 'GET', path: '/api/master/voice-session' },
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

/** Status and content type of the Rust gateway for a streaming route, without draining the body. */
async function rustHead(path) {
  if (process.env.GATEWAY_BASE_URL) {
    const response = await fetch(`${RUST_ORIGIN}${path}`, { signal: AbortSignal.timeout(20000) });
    const contentType = response.headers.get('content-type') ?? '';
    await response.body?.cancel();
    return { status: response.status, contentType };
  }
  let output = '';
  try {
    output = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER,
        'curl',
        '-s',
        '-m',
        '2',
        '-D',
        '-',
        '-o',
        '/dev/null',
        `${RUST_ORIGIN}${path}`,
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
  } catch (error) {
    // curl exits 28 on the -m timeout; the dumped headers are still on stdout.
    output = String(error.stdout ?? '');
  }
  const status = Number(/^HTTP\/\S+\s+(\d{3})/m.exec(output)?.[1] ?? 0);
  const contentType = /^content-type:\s*(.*)$/im.exec(output)?.[1]?.trim() ?? '';
  return { status, contentType };
}

function mediaType(value) {
  return String(value ?? '')
    .split(';')[0]
    .trim();
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

async function runHeadCase(c) {
  const rust = await rustHead(c.path);
  const ts = await tsCall(c.route, c.method, c.path);
  check(`${c.label}: Status`, rust.status, ts.status);
  check(`${c.label}: Content-Type`, mediaType(rust.contentType), mediaType(ts.contentType));
}

async function runCase(c) {
  try {
    if (c.kind === 'head') return await runHeadCase(c);
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
